/**
 * Opening Drive — catalyst classification (spec §PHASE 1 CATALYST FILTER).
 *
 * Uses BOTH sources per the user's decision:
 *   • Polygon /v2/reference/news `published_utc` is the timestamp authority for
 *     the freshness test (Finviz export carries no timestamp) and supplies
 *     per-ticker sentiment for the strength heuristic. Reuses `fetchTickerNews`
 *     from cveData.ts.
 *   • A Finviz headline (when present) is merged in as extra coverage.
 *
 * Classification (spec):
 *   NEWS — a headline dated after the prior session's 16:00 ET close
 *   ATH  — no fresh news but price is at/through the lookback high (price catalyst)
 *   BASE — no fresh news but within 1% of the 250-session high (weaker)
 *   NONE — none of the above
 */

import { fetchTickerNews } from "../cveData.js";
import type { NewsItem } from "../cve.js";
import type { OpeningDriveConfig } from "./config.js";

export type CatalystType = "NEWS" | "ATH" | "BASE" | "NONE";
export type CatalystStrength = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface CatalystResult {
  type: CatalystType;
  strength: CatalystStrength;
  headline: string | null;
  source: string | null;
  publishedEt: string | null;
  sentiment: string | null;
}

/**
 * The prior session's 16:00 ET close, as an epoch-ms boundary. Rolls back over
 * weekends (Mon scan → Fri 16:00). Market holidays are a known v1 gap handled by
 * the calendar util in a later pass.
 */
export function priorCloseBoundary(scanTime: Date): number {
  const d = new Date(scanTime);
  d.setUTCDate(d.getUTCDate() - 1);
  // Weekend roll-back using ET weekday.
  for (let i = 0; i < 3; i++) {
    const wd = new Date(d).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
    if (wd !== "Sat" && wd !== "Sun") break;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  // Build 16:00 ET on that calendar day. ET offset is -4 (EDT) or -5 (EST);
  // derive it from the date rather than hardcoding.
  const ymd = new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const [y, mo, da] = ymd.split("-").map(Number);
  // 16:00 ET → probe both offsets and pick the one whose ET rendering is 16:00.
  for (const off of [4, 5]) {
    const ts = Date.UTC(y, mo - 1, da, 16 + off, 0, 0);
    const hh = new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" });
    if (Number(hh) === 16) return ts;
  }
  return Date.UTC(y, mo - 1, da, 20, 0, 0); // fallback: 16:00 EDT
}

function etClock(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function scoreStrength(headline: string, sentiment: string | null, cfg: OpeningDriveConfig): CatalystStrength {
  const h = headline.toLowerCase();
  if (cfg.catalystKeywordsHigh.some((k) => h.includes(k))) return "HIGH";
  if (cfg.catalystKeywordsMedium.some((k) => h.includes(k))) return "MEDIUM";
  if (cfg.catalystKeywordsLow.some((k) => h.includes(k))) return "LOW";
  // No keyword hit: let a strong sentiment lift an otherwise-unclassified fresh
  // headline to MEDIUM, else LOW.
  if (sentiment === "positive" || sentiment === "negative") return "MEDIUM";
  return "LOW";
}

/**
 * Classify a single candidate. `ath`/`nearBaseHigh` come from the daily-levels
 * pass (price catalysts that don't need news). `finvizHeadline` is optional
 * extra coverage merged in when Polygon is thin.
 */
export async function classifyCatalyst(
  ticker: string,
  scanTime: Date,
  ath: boolean,
  nearBaseHigh: boolean,
  cfg: OpeningDriveConfig,
  finvizHeadline?: string,
): Promise<CatalystResult> {
  const boundary = priorCloseBoundary(scanTime);
  let news: NewsItem[] = [];
  try {
    news = await fetchTickerNews(ticker);
  } catch {
    news = [];
  }

  const fresh = news
    .filter((n) => {
      if (!n.publishedUtc) return false;
      const t = new Date(n.publishedUtc).getTime();
      return t > boundary && t <= scanTime.getTime();
    })
    .sort((a, b) => new Date(b.publishedUtc).getTime() - new Date(a.publishedUtc).getTime());

  if (fresh.length) {
    const top = fresh[0];
    return {
      type: "NEWS",
      strength: scoreStrength(top.title, top.sentiment ?? null, cfg),
      headline: top.title,
      source: top.publisher ?? null,
      publishedEt: etClock(top.publishedUtc),
      sentiment: top.sentiment ?? null,
    };
  }

  if (ath) {
    return { type: "ATH", strength: "MEDIUM", headline: finvizHeadline ?? null, source: finvizHeadline ? "finviz" : null, publishedEt: null, sentiment: null };
  }
  if (nearBaseHigh) {
    return { type: "BASE", strength: "LOW", headline: finvizHeadline ?? null, source: finvizHeadline ? "finviz" : null, publishedEt: null, sentiment: null };
  }
  return { type: "NONE", strength: "NONE", headline: finvizHeadline ?? null, source: finvizHeadline ? "finviz" : null, publishedEt: null, sentiment: null };
}
