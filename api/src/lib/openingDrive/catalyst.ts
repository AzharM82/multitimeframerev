/**
 * Opening Drive — catalyst classification (spec §PHASE 1 CATALYST FILTER).
 *
 * Uses BOTH sources per the user's decision:
 *   • Polygon /v2/reference/news `published_utc` supplies per-ticker sentiment
 *     for the strength heuristic. Reuses `fetchTickerNews` from cveData.ts.
 *   • The Finviz headline, with its own `News Time` timestamp.
 *
 * The Finviz headline used to be attached for DISPLAY only and never actually
 * classified — the old docstring claimed it was "merged in as extra coverage",
 * but every return path below `fresh.length` set `type` from price levels alone
 * and just hung the headline off the result. So a name whose only catalyst was
 * a Finviz story graded NONE while carrying the story in its payload: on
 * 2026-08-07 TEAM read `NONE/NONE` next to "Atlassian Stock Soars 30% on
 * Blowout Earnings", and only escaped demotion because the sector-sympathy rule
 * happened to rescue it. It is now a first-class source, ranked with Polygon's
 * by recency.
 *
 * That was only possible once the scan actually requested Finviz's `News Time`
 * (column 137/135 — the old column list returned neither). The original comment
 * "Finviz export carries no timestamp" was true of the broken column list, not
 * of Finviz.
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

/**
 * Parse Finviz's `News Time` ("2026-08-07 15:22:33", Eastern) to epoch ms.
 *
 * Finviz states the wall clock with no offset, so the offset is derived by
 * probing EDT/EST and keeping whichever renders back to the same ET hour —
 * the same trick `priorCloseBoundary` uses. Returns null on anything
 * unparseable, which keeps the headline out of the freshness test rather than
 * letting an unknown timestamp masquerade as fresh.
 */
export function parseFinvizNewsTime(raw: string | undefined): number | null {
  const m = (raw ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d, hh, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const ss = m[6] ? Number(m[6]) : 0;
  for (const off of [4, 5]) {
    const ts = Date.UTC(y, mo - 1, d, hh + off, mi, ss);
    const back = new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" });
    // `hour12:false` renders midnight as "24" in some ICU builds — normalise.
    if (Number(back) % 24 === hh) return ts;
  }
  return null;
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
  finvizNewsTime?: string,
): Promise<CatalystResult> {
  const boundary = priorCloseBoundary(scanTime);
  let news: NewsItem[] = [];
  try {
    news = await fetchTickerNews(ticker);
  } catch {
    news = [];
  }

  /** Both sources, normalised, so recency can rank them against each other. */
  interface Story { title: string; at: number; source: string | null; sentiment: string | null }
  const isFresh = (t: number) => t > boundary && t <= scanTime.getTime();

  const stories: Story[] = news
    .filter((n) => n.publishedUtc && isFresh(new Date(n.publishedUtc).getTime()))
    .map((n) => ({
      title: n.title,
      at: new Date(n.publishedUtc).getTime(),
      source: n.publisher ?? null,
      sentiment: n.sentiment ?? null,
    }));

  // Finviz carries only the LATEST headline per ticker, so it adds at most one
  // story — but it is often the one Polygon is missing.
  const fvAt = parseFinvizNewsTime(finvizNewsTime);
  if (finvizHeadline && fvAt !== null && isFresh(fvAt)) {
    stories.push({ title: finvizHeadline, at: fvAt, source: "finviz", sentiment: null });
  }

  if (stories.length) {
    const top = stories.sort((a, b) => b.at - a.at)[0];
    return {
      type: "NEWS",
      strength: scoreStrength(top.title, top.sentiment, cfg),
      headline: top.title,
      source: top.source,
      publishedEt: etClock(new Date(top.at).toISOString()),
      sentiment: top.sentiment,
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
