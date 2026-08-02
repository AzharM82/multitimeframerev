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

// ─── Finviz gap-up universe (one call: Ticker + Sector + MktCap + Price + …) ─

const FV_COLS = "0,1,2,3,4,6,25,26,30,63,65,66,67,68"; // named columns incl Sector, Market Cap, Price, Change, Volume, Gap, Avg Volume, ATR, News
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
      marketCap: parseHuman(r["Market Cap"]),
      price: parseHuman(r["Price"]),
      gapPct: parseHuman(r["Gap"]),
      headline: (r["News"] ?? "").trim() || null,
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
}

// ─── SPY regime ─────────────────────────────────────────────────────────────

function sma(vals: number[], n: number): number | null {
  if (vals.length < n) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

async function computeRegime(scanDate: string): Promise<{ regime: Regime; spyPct: number | null }> {
  try {
    const daily = await fetchDailyBarsExtended("SPY", 1);
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
  const prefiltered = universe
    .filter((r) => (r.marketCap ?? 0) >= cfg.minMarketCap && (r.price ?? 0) >= cfg.minPrice)
    .slice(0, 30);

  // Sector-ETF pre-market changes (one snapshot call for the ETFs in play).
  const etfs = [...new Set(prefiltered.map((r) => SECTOR_ETF[r.sector]).filter(Boolean))] as string[];
  const etfQuotes = etfs.length ? await fetchQuotes(etfs) : new Map();

  const built = await mapLimit(prefiltered, 6, async (row): Promise<OpeningDriveCandidate | null> => {
    const reasons: string[] = [];
    try {
      const [oneMin, daily] = await Promise.all([
        fetchAggsRange(row.ticker, 1, "minute", scanDate, scanDate),
        fetchDailyBarsExtended(row.ticker, 2),
      ]);
      if (daily.length < 20) { return null; }

      const pm = premarketStats(oneMin);
      if (pm.pmLast <= 0) return null;

      const levels = computeLevels(daily, pm.pmLast);
      const gapPct = levels.priorClose ? ((pm.pmLast - levels.priorClose) / levels.priorClose) * 100 : (row.gapPct ?? 0);
      const atrPct = levels.priorClose ? (levels.atr14d / levels.priorClose) * 100 : 0;
      const nearBaseHigh = levels.distToResistancePct !== null && levels.distToResistancePct <= 1;
      const avgDollarVol = pm.pmLast * levels.avgDailyVol30d;

      // Candidate criteria (spec §CANDIDATE CRITERIA + liquidity/price floors).
      const pmVolOk = pm.pmVolume >= cfg.minPmVolume || pm.pmVolume >= cfg.minPmVolRatio * levels.avgDailyVol30d;
      const roomOk = levels.ath || (levels.distToResistancePct !== null && levels.distToResistancePct >= cfg.minRoomOverheadPct);
      const checks: [boolean, string][] = [
        [pm.pmLast >= cfg.minPrice, `price ${pm.pmLast} >= ${cfg.minPrice}`],
        [avgDollarVol >= cfg.minAvgDollarVol, `avg$vol ${(avgDollarVol / 1e6).toFixed(1)}M >= ${(cfg.minAvgDollarVol / 1e6)}M`],
        [gapPct >= cfg.minGapPct, `gap ${gapPct.toFixed(1)}% >= ${cfg.minGapPct}%`],
        [pm.pmLast > levels.ydayHigh, `pm_last ${pm.pmLast} > yday_high ${levels.ydayHigh}`],
        [pm.pmLast > levels.priorClose, `pm_last > prior_close ${levels.priorClose}`],
        [pmVolOk, `pm_volume ${Math.round(pm.pmVolume)}`],
        [atrPct >= cfg.minAtrRatio * 100, `atr% ${atrPct.toFixed(2)} >= ${(cfg.minAtrRatio * 100).toFixed(1)}`],
        [roomOk, `room ${levels.ath ? "ATH" : levels.distToResistancePct?.toFixed(1) + "%"}`],
      ];
      for (const [ok, msg] of checks) if (!ok) reasons.push("FAIL " + msg);
      if (reasons.length) return null; // fails a hard criterion — not a candidate

      const catalyst = await classifyCatalyst(row.ticker, scanTime, levels.ath, nearBaseHigh, cfg, row.headline ?? undefined);
      const etf = SECTOR_ETF[row.sector] ?? null;
      const etfQ = etf ? etfQuotes.get(etf) : null;

      return {
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
      };
    } catch {
      return null;
    }
  });

  const candidates = built.filter((c): c is OpeningDriveCandidate => c !== null);

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
  };
}
