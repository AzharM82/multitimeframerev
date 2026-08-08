/**
 * Opening Drive — Phase 1 pre-market scan (spec §PHASE 1).
 *
 * Builds the candidate list at 9:28 ET: a Finviz gap-up universe, enriched with
 * Polygon pre-market aggregates + daily levels, filtered by the candidate
 * criteria, classified by catalyst, and tagged with the market regime and a
 * sector tailwind. The trimmed candidate list is what Phase 2 (DESKTOP2) watches.
 *
 * Reuses: Finviz export (`finvizElite.fetchExportFromUrl`), Polygon snapshot
 * (`cveData.fetchQuotes`), daily levels (`levels.computeLevels`), catalyst
 * (`catalyst.classifyCatalyst`).
 */

import { fetchExportFromUrl, isEliteConfigured } from "../finvizElite.js";
import { fetchQuotes } from "../cveData.js";
import { fetchAggsRange, fetchDailyBarsExtended } from "../polygon.js";
import type { Candle } from "../indicators.js";
import { computeLevels } from "./levels.js";
import { etMinutes } from "./trigger.js";
import { classifyCatalyst, type CatalystResult } from "./catalyst.js";
import { loadConfig, type OpeningDriveConfig } from "./config.js";

// ─── Regime + sector ────────────────────────────────────────────────────────

export type Regime = "GREEN" | "YELLOW" | "RED";

const SECTOR_ETF: Record<string, string> = {
  Technology: "XLK",
  Financial: "XLF",
  "Financial Services": "XLF",
  Healthcare: "XLV",
  Energy: "XLE",
  "Consumer Cyclical": "XLY",
  "Consumer Defensive": "XLP",
  Industrials: "XLI",
  "Basic Materials": "XLB",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  "Communication Services": "XLC",
};

// ─── Human-number parsing (Finviz "1.23B" / "456.7M") ───────────────────────

function parseHuman(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[$,%]/g, "");
  const m = s.match(/^(-?[\d.]+)([KMBT])?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || "").toUpperCase()] ?? 1;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n * mult : null;
}

/**
 * Market cap in DOLLARS from a Finviz export cell.
 *
 * The `v=152` export returns market cap as a bare number in MILLIONS
 * ("37471.37" = $37.47B), not the suffixed form ("37.47B") `parseHuman` expects.
 * Reading it raw made every name look sub-$500M, so the market-cap prefilter
 * silently emptied the universe and the scan produced 0 candidates for two
 * sessions (2026-08-06/07) while still reporting a healthy `discovered` count.
 *
 * Accept both shapes so a future Finviz flip can't re-break it: an explicit
 * K/M/B/T suffix is already absolute, a bare number is millions.
 */
function parseMarketCap(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[$,%]/g, "");
  if (/[KMBT]$/i.test(s)) return parseHuman(s);
  const n = Number(s);
  return Number.isFinite(n) ? n * 1e6 : null;
}

// ─── Finviz gap-up universe (one call: Ticker + Sector + MktCap + Price + …) ─

// Finviz column INDICES (verified against the live v=152 export 2026-08-07):
//   0 No. · 1 Ticker · 2 Company · 3 Sector · 4 Industry · 6 Market Cap
//   60 Change from Open · 61 Gap · 63 Average Volume · 64 Relative Volume
//   65 Price · 66 Change · 67 Volume · 135 News Time · 136 News URL · 137 News Title
// The previous list asked for 25/26/30 (Shares Float, Insider Own, Short Float)
// while its comment claimed Gap/ATR/News — so `Gap` and the news headline were
// never actually returned, and the catalyst classifier ran without a headline.
// There is no ATR column in this view; ATR is computed from Polygon dailies.
const FV_COLS = "0,1,2,3,4,6,60,61,63,64,65,66,67,135,136,137";
function finvizGapUrl(cfg: OpeningDriveConfig): string {
  const gapTok = `ta_gap_u${Math.max(1, Math.round(cfg.minGapPct))}`; // e.g. ta_gap_u2
  // sh_price_o50 mirrors the $50 config floor; sh_avgvol_o500 keeps liquid names.
  const priceTok = cfg.minPrice >= 50 ? "sh_price_o50" : cfg.minPrice >= 20 ? "sh_price_o20" : "sh_price_o5";
  const f = `geo_usa,sh_avgvol_o500,${priceTok},${gapTok},sh_opt_option`;
  return `https://elite.finviz.com/export?v=152&f=${f}&o=-gap&c=${FV_COLS}`;
}

interface FinvizRow {
  ticker: string;
  sector: string;
  marketCap: number | null;
  price: number | null;
  gapPct: number | null;
  headline: string | null;
  /** Finviz `News Time`, "YYYY-MM-DD HH:MM:SS" in ET. Drives the freshness test. */
  newsTime: string | null;
}

async function fetchGapUniverse(cfg: OpeningDriveConfig): Promise<FinvizRow[]> {
  if (!isEliteConfigured()) return [];
  const rows = await fetchExportFromUrl(finvizGapUrl(cfg), "opening-drive");
  const out: FinvizRow[] = [];
  for (const r of rows) {
    const ticker = (r["Ticker"] ?? "").trim().toUpperCase();
    if (!/^[A-Z]{1,5}$/.test(ticker)) continue;
    out.push({
      ticker,
      sector: (r["Sector"] ?? "").trim(),
      marketCap: parseMarketCap(r["Market Cap"]),
      price: parseHuman(r["Price"]),
      gapPct: parseHuman(r["Gap"]),
      headline: (r["News Title"] ?? "").trim() || null,
      newsTime: (r["News Time"] ?? "").trim() || null,
    });
  }
  return out;
}

// ─── Pre-market stats from Polygon minute aggs ──────────────────────────────

interface PmStats {
  pmHigh: number;
  pmVolume: number;
  pmLast: number;
}

function premarketStats(oneMin: Candle[]): PmStats {
  let pmHigh = 0, pmVolume = 0, pmLast = 0;
  for (const b of oneMin) {
    const mins = etMinutes(b.timestamp);
    if (mins >= 240 && mins < 568) { // 04:00–09:28 ET
      if (b.high > pmHigh) pmHigh = b.high;
      pmVolume += b.volume;
      pmLast = b.close;
    }
  }
  return { pmHigh, pmVolume, pmLast };
}

// ─── Candidate record ───────────────────────────────────────────────────────

export interface OpeningDriveCandidate {
  ticker: string;
  gapPct: number;
  pmHigh: number;
  pmVolume: number;
  pmLast: number;
  ydayHigh: number;
  priorClose: number;
  atrPct: number;
  roomOverheadPct: number | null;
  ath: boolean;
  sector: string;
  sectorEtf: string | null;
  sectorEtfPct: number | null;
  marketCap: number | null;
  catalystType: CatalystResult["type"];
  catalystStrength: CatalystResult["strength"];
  catalystHeadline: string | null;
  catalystSource: string | null;
  catalystTimeEt: string | null;
  sectorSympathy: boolean;
  demoted: boolean;
  reasons: string[];
}

export interface ScanResult {
  asOf: string;
  regime: Regime;
  spyPct: number | null;
  discovered: number;
  candidates: OpeningDriveCandidate[];
  /**
   * Why the scan produced what it did. Without this a broken upstream feed is
   * indistinguishable from a genuinely quiet market — the Finviz market-cap
   * format change on 2026-08-06 emptied the universe for two sessions and the
   * only visible symptom was `candidates: []` next to a healthy `discovered`.
   */
  rejections: {
    /** Dropped by the cheap Finviz prefilter, before any enrichment. */
    prefilterMarketCap: number;
    prefilterPrice: number;
    enriched: number;
    /** gate key → how many enriched names that gate rejected. */
    byGate: Record<string, number>;
    /** Per-ticker detail, for the tab and for research. */
    detail: { ticker: string; fails: string[] }[];
  };
}

/** Enrichment outcome: a candidate, or the gates it failed. */
type Enriched =
  | { ok: true; candidate: OpeningDriveCandidate }
  | { ok: false; ticker: string; fails: string[] };

// ─── Daily bars must end on the last COMPLETED session ──────────────────────

/**
 * Drop any daily bar dated on/after `scanDate` (ET).
 *
 * `fetchDailyBarsExtended` fetches through `new Date()`, so once Polygon opens
 * the current session's daily aggregate (shortly after 09:30 ET) the last bar
 * is TODAY's in-progress bar. `computeLevels` then reads `priorClose`/`ydayHigh`
 * off today itself: gaps compute as ~0 or negative, and `pm_last > yday_high`
 * can never pass because today's high already contains the pre-market high.
 *
 * The live 09:28 cron ran before that bar existed, so it was unaffected — but
 * any manual re-trigger or replay after the open silently produced garbage.
 * levels.ts is documented to operate on the last completed session; enforce it.
 */
function completedSessionsOnly(daily: Candle[], scanDate: string): Candle[] {
  return daily.filter(
    (b) => new Date(b.timestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) < scanDate,
  );
}

// ─── SPY regime ─────────────────────────────────────────────────────────────

function sma(vals: number[], n: number): number | null {
  if (vals.length < n) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

async function computeRegime(scanDate: string): Promise<{ regime: Regime; spyPct: number | null }> {
  try {
    const daily = completedSessionsOnly(await fetchDailyBarsExtended("SPY", 1), scanDate);
    const closes = daily.map((c) => c.close);
    const lastClose = closes[closes.length - 1];
    const s10 = sma(closes, 10);
    const s20 = sma(closes, 20);
    const smaPass = s10 !== null && s20 !== null && lastClose > s10 && lastClose > s20;

    const spyMin = await fetchAggsRange("SPY", 1, "minute", scanDate, scanDate);
    const pm = premarketStats(spyMin);
    const spyPct = pm.pmLast && lastClose ? ((pm.pmLast - lastClose) / lastClose) * 100 : null;
    const pmGreen = spyPct !== null && spyPct >= 0;

    const regime: Regime = smaPass && pmGreen ? "GREEN" : smaPass ? "YELLOW" : "RED";
    return { regime, spyPct };
  } catch {
    return { regime: "YELLOW", spyPct: null };
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/** Small helper to run async work in bounded-concurrency batches (timeout safety). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

export async function runScan(
  cfg: OpeningDriveConfig = loadConfig(),
  scanTime: Date = new Date(),
): Promise<ScanResult> {
  const scanDate = scanTime.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD ET

  const [universe, regimeInfo] = await Promise.all([
    fetchGapUniverse(cfg),
    computeRegime(scanDate),
  ]);

  // Cheap pre-filter on the Finviz columns, then cap for the expensive enrichment.
  const capOk = universe.filter((r) => (r.marketCap ?? 0) >= cfg.minMarketCap);
  const prefilterMarketCap = universe.length - capOk.length;
  const priceOk = capOk.filter((r) => (r.price ?? 0) >= cfg.minPrice);
  const prefilterPrice = capOk.length - priceOk.length;
  const prefiltered = priceOk.slice(0, 30);

  // Sector-ETF pre-market changes (one snapshot call for the ETFs in play).
  const etfs = [...new Set(prefiltered.map((r) => SECTOR_ETF[r.sector]).filter(Boolean))] as string[];
  const etfQuotes = etfs.length ? await fetchQuotes(etfs) : new Map();

  const built = await mapLimit(prefiltered, 6, async (row): Promise<Enriched> => {
    const reasons: string[] = [];
    const reject = (fails: string[]): Enriched => ({ ok: false, ticker: row.ticker, fails });
    try {
      const [oneMin, dailyRaw] = await Promise.all([
        fetchAggsRange(row.ticker, 1, "minute", scanDate, scanDate),
        fetchDailyBarsExtended(row.ticker, 2),
      ]);
      const daily = completedSessionsOnly(dailyRaw, scanDate);
      if (daily.length < 20) { return reject(["history insufficient daily bars"]); }

      const pm = premarketStats(oneMin);
      if (pm.pmLast <= 0) return reject(["premarket no trades 04:00–09:28 ET"]);

      const levels = computeLevels(daily, pm.pmLast);
      const gapPct = levels.priorClose ? ((pm.pmLast - levels.priorClose) / levels.priorClose) * 100 : (row.gapPct ?? 0);
      const atrPct = levels.priorClose ? (levels.atr14d / levels.priorClose) * 100 : 0;
      const nearBaseHigh = levels.distToResistancePct !== null && levels.distToResistancePct <= 1;
      const avgDollarVol = pm.pmLast * levels.avgDailyVol30d;

      // Candidate criteria (spec §CANDIDATE CRITERIA + liquidity/price floors).
      const pmVolOk = pm.pmVolume >= cfg.minPmVolume || pm.pmVolume >= cfg.minPmVolRatio * levels.avgDailyVol30d;
      const roomOk = levels.ath || (levels.distToResistancePct !== null && levels.distToResistancePct >= cfg.minRoomOverheadPct);
      // [passed, gate-key, human detail] — the gate key is the tally dimension,
      // so keep it stable: it is what /api/opening-drive-results reports back.
      const checks: [boolean, string, string][] = [
        [pm.pmLast >= cfg.minPrice, "price", `${pm.pmLast} >= ${cfg.minPrice}`],
        [avgDollarVol >= cfg.minAvgDollarVol, "avg$vol", `${(avgDollarVol / 1e6).toFixed(1)}M >= ${(cfg.minAvgDollarVol / 1e6)}M`],
        [gapPct >= cfg.minGapPct, "gap", `${gapPct.toFixed(1)}% >= ${cfg.minGapPct}%`],
        [pm.pmLast > levels.ydayHigh, "yday_high", `pm_last ${pm.pmLast} > ${levels.ydayHigh}`],
        [pm.pmLast > levels.priorClose, "prior_close", `pm_last ${pm.pmLast} > ${levels.priorClose}`],
        [pmVolOk, "pm_volume", `${Math.round(pm.pmVolume)} (need ${cfg.minPmVolume} or ${cfg.minPmVolRatio * 100}% of ${Math.round(levels.avgDailyVol30d)})`],
        [atrPct >= cfg.minAtrRatio * 100, "atr%", `${atrPct.toFixed(2)} >= ${(cfg.minAtrRatio * 100).toFixed(1)}`],
        [roomOk, "room", `${levels.ath ? "ATH" : levels.distToResistancePct?.toFixed(1) + "%"} >= ${cfg.minRoomOverheadPct}%`],
      ];
      for (const [ok, gate, detail] of checks) if (!ok) reasons.push(`${gate} ${detail}`);
      if (reasons.length) return reject(reasons); // fails a hard criterion — not a candidate

      const catalyst = await classifyCatalyst(
        row.ticker, scanTime, levels.ath, nearBaseHigh, cfg,
        row.headline ?? undefined, row.newsTime ?? undefined,
      );
      const etf = SECTOR_ETF[row.sector] ?? null;
      const etfQ = etf ? etfQuotes.get(etf) : null;

      return { ok: true, candidate: {
        ticker: row.ticker,
        gapPct,
        pmHigh: pm.pmHigh,
        pmVolume: pm.pmVolume,
        pmLast: pm.pmLast,
        ydayHigh: levels.ydayHigh,
        priorClose: levels.priorClose,
        atrPct,
        roomOverheadPct: levels.distToResistancePct,
        ath: levels.ath,
        sector: row.sector,
        sectorEtf: etf,
        sectorEtfPct: etfQ ? etfQ.changePct : null,
        marketCap: row.marketCap,
        catalystType: catalyst.type,
        catalystStrength: catalyst.strength,
        catalystHeadline: catalyst.headline,
        catalystSource: catalyst.source,
        catalystTimeEt: catalyst.publishedEt,
        sectorSympathy: false,
        demoted: false,
        reasons: [],
      } };
    } catch (err) {
      return reject([`error ${err instanceof Error ? err.message : "unknown"}`]);
    }
  });

  const candidates = built.filter((r): r is Extract<Enriched, { ok: true }> => r.ok).map((r) => r.candidate);

  // Rejection telemetry — see ScanResult.rejections.
  const rejectedRows = built.filter((r): r is Extract<Enriched, { ok: false }> => !r.ok);
  const byGate: Record<string, number> = {};
  for (const r of rejectedRows) {
    for (const f of r.fails) {
      const gate = f.split(" ")[0];
      byGate[gate] = (byGate[gate] ?? 0) + 1;
    }
  }

  // Sector-sympathy: 3+ candidates share a sector ETF and ≥1 is NEWS/HIGH.
  const bySector = new Map<string, OpeningDriveCandidate[]>();
  for (const c of candidates) {
    if (!c.sectorEtf) continue;
    (bySector.get(c.sectorEtf) ?? bySector.set(c.sectorEtf, []).get(c.sectorEtf)!).push(c);
  }
  for (const group of bySector.values()) {
    if (group.length >= 3 && group.some((c) => c.catalystType === "NEWS" && c.catalystStrength === "HIGH")) {
      for (const c of group) if (!(c.catalystType === "NEWS" && c.catalystStrength === "HIGH")) c.sectorSympathy = true;
    }
  }

  // No-catalyst handling (spec: demote | block | allow).
  const final: OpeningDriveCandidate[] = [];
  for (const c of candidates) {
    const noCatalyst = c.catalystType === "NONE" && !c.sectorSympathy;
    if (noCatalyst && cfg.noCatalystAction === "block") continue;
    if (noCatalyst && cfg.noCatalystAction === "demote") c.demoted = true;
    final.push(c);
  }
  // Sort: live candidates first, demoted to the bottom; within each, by gap%.
  final.sort((a, b) => (Number(a.demoted) - Number(b.demoted)) || (b.gapPct - a.gapPct));

  return {
    asOf: scanTime.toISOString(),
    regime: regimeInfo.regime,
    spyPct: regimeInfo.spyPct,
    discovered: universe.length,
    candidates: final,
    rejections: {
      prefilterMarketCap,
      prefilterPrice,
      enriched: prefiltered.length,
      byGate,
      detail: rejectedRows.map((r) => ({ ticker: r.ticker, fails: r.fails })),
    },
  };
}
