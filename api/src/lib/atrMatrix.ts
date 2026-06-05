/**
 * ATR Matrix math — TypeScript port of the ATRScanner `metrics.py`.
 *
 * The whole methodology lives here so the rules are in one place: extension
 * (how many ATRs a stock sits above its SMA50), zones, a 0–6 trend-structure
 * score → A–G grade, universe-relative RS percentiles, and a single tunable
 * action signal. Daily bars only. Pure functions — no I/O.
 *
 * Framework credit: @SteveDJacobs ("ATR Matrix" / Relative Trend Strength).
 * Reuses computeATR (Wilder) and computeEMA from indicators.ts so the ATR here
 * matches the rest of the portal.
 */

import { computeATR, computeEMA, type Candle } from "./indicators.js";
import type { FinvizMatrixRow } from "./atrUniverse.js";

const ATR_LEN = 14;

// structure score (0–6) → grade letter
const LETTER: Record<number, string> = { 6: "A", 5: "B", 4: "C", 3: "D", 2: "E", 1: "F", 0: "G" };

export type AtrZone = "LEAVE" | "ENTRY" | "HOLD" | "EXTENDED" | "BLOWOFF";
export type AtrAction = "sell" | "reduce" | "inflection" | "restore" | "buy" | "hold";

export interface AtrStock {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number; // dollars (0 if unknown)
  close: number;
  chg: number; // % change vs prev close
  atr: number;
  atrPct: number;
  ext: number; // (close - sma50) / atr
  extPrev: number;
  bucket: number; // floor(ext) clamped [-5, 11]
  zone: AtrZone;
  sma50: number;
  sma20: number;
  sma200: number;
  structure: number; // 0–6
  ema10: number;
  ema10Prev: number;
  sma20Prev: number;
  prevClose: number;
  dvol: number; // 20d avg dollar-volume, $millions
  r1w: number;
  r1m: number;
  r3m: number;
  r6m: number;
  aboveSMA50: boolean;
  stopSuggest: number;
  ladder: Record<number, number>; // extension target prices (7x..11x)
  rvol?: number;    // relative volume (today vs avg) — volume confirmation
  volWeek?: number; // weekly volatility % (Finviz path) — for the candidates filter
  avgVol?: number;  // avg daily volume, shares (Finviz path) — for the candidates filter
  // filled by finalize():
  atrRS: number; // ATR% percentile within universe (0–100)
  rs: number; // max return percentile across 1w/1m/3m/6m (0–100)
  grade: string;
  action: AtrAction;
}

/** Minimum daily bars compute_stock needs (SMA200 + lookback headroom). */
export const MIN_BARS = 210;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** floor(extension) clamped to the displayed range [-5, 11]. */
export function extensionBucket(ext: number): number {
  return Math.max(-5, Math.min(11, Math.floor(ext)));
}

export function zoneForBucket(b: number): AtrZone {
  if (b < 0) return "LEAVE";
  if (b <= 4) return "ENTRY";
  if (b <= 6) return "HOLD";
  if (b <= 10) return "EXTENDED";
  return "BLOWOFF";
}

/** Simple moving average of `n` values ending `fromEnd` bars from the end
 *  (fromEnd=1 → last bar = iloc[-1]; fromEnd=2 → iloc[-2]; fromEnd=6 → iloc[-6]). */
function smaAt(values: number[], n: number, fromEnd = 1): number {
  const end = values.length - fromEnd + 1; // exclusive
  const start = end - n;
  if (start < 0 || end > values.length) return NaN;
  let s = 0;
  for (let i = start; i < end; i++) s += values[i];
  return s / n;
}

// ─── per-ticker metrics ──────────────────────────────────────────────────────

type StockCore = Omit<AtrStock, "ticker" | "company" | "sector" | "industry" | "marketCap" | "atrRS" | "rs" | "grade" | "action">;

/**
 * Per-ticker metrics from daily bars (oldest → newest).
 * Returns null when there is not enough history for SMA200 + lookbacks.
 */
export function computeStock(candles: Candle[]): StockCore | null {
  if (!candles || candles.length < MIN_BARS) return null;

  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const atrArr = computeATR(candles, ATR_LEN);
  const L = candles.length;

  const close = closes[L - 1];
  const prev = closes[L - 2];
  const atrD = atrArr[L - 1];
  if (!(atrD > 0) || !(close > 0)) return null;
  const atrPct = (100 * atrD) / close;

  const sma50 = smaAt(closes, 50, 1);
  const sma20 = smaAt(closes, 20, 1);
  const sma100 = smaAt(closes, 100, 1);
  const sma200 = smaAt(closes, 200, 1);

  const ema10Arr = computeEMA(closes, 10);
  const ema10 = ema10Arr[L - 1];
  const ema10Prev = ema10Arr[L - 2];
  const sma20Prev = smaAt(closes, 20, 2);
  const sma50Prev = smaAt(closes, 50, 2);
  const sma50_5ago = smaAt(closes, 50, 6);

  const ext = (close - sma50) / atrD;
  const extPrev = (prev - sma50Prev) / atrArr[L - 2];

  const structure =
    (close >= ema10 ? 1 : 0) +
    (ema10 >= sma20 ? 1 : 0) +
    (sma20 >= sma50 ? 1 : 0) +
    (sma50 >= sma100 ? 1 : 0) +
    (sma100 >= sma200 ? 1 : 0) +
    (sma50 > sma50_5ago ? 1 : 0);

  const ret = (d: number): number => (L > d ? closes[L - 1] / closes[L - 1 - d] - 1 : 0);

  // 20-day average dollar volume, in $millions
  let dvolSum = 0;
  const dvStart = Math.max(0, L - 20);
  for (let i = dvStart; i < L; i++) dvolSum += closes[i] * vols[i];
  const dvol = dvolSum / (L - dvStart) / 1e6;

  const bucket = extensionBucket(ext);
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const ladder: Record<number, number> = {};
  for (const k of [7, 8, 9, 10, 11]) ladder[k] = round2(sma50 + k * atrD);

  return {
    close: round2(close),
    chg: round2(100 * (close / prev - 1)),
    atr: round2(atrD),
    atrPct: round2(atrPct),
    ext: round2(ext),
    extPrev: round2(extPrev),
    bucket,
    zone: zoneForBucket(bucket),
    sma50: round2(sma50),
    sma20: round2(sma20),
    sma200: round2(sma200),
    structure,
    ema10,
    ema10Prev,
    sma20Prev,
    prevClose: prev,
    dvol: Math.round(dvol * 10) / 10,
    r1w: ret(5),
    r1m: ret(21),
    r3m: ret(63),
    r6m: ret(126),
    aboveSMA50: close >= sma50,
    stopSuggest: round2(close - 1.5 * atrD),
    ladder,
  };
}

// ─── action signal (one tunable pure function) ──────────────────────────────

export function action(s: { close: number; sma50: number; sma20: number; prevClose: number; ema10Prev: number; ema10: number; structure: number; sma20Prev: number; ext: number }, atrRS: number): AtrAction {
  if (s.close < s.sma50) return "sell"; // below SMA50
  if (s.close < s.sma20) return "reduce"; // below SMA20 but holding SMA50
  if (s.prevClose < s.ema10Prev && s.close >= s.ema10 && s.structure >= 4) return "inflection"; // reclaimed EMA10
  if (s.prevClose < s.sma20Prev && s.close >= s.sma20) return "restore"; // reclaimed SMA20
  if (s.structure >= 5 && s.ext >= 0 && s.ext <= 4 && atrRS >= 50) return "buy"; // aligned, un-extended, volatile
  return "hold";
}

/** Action for the Finviz path — same gates as action() but without the reclaim
 *  (inflection/restore) branches, which need prior-bar data a screener snapshot
 *  doesn't carry. */
export function actionFinviz(
  s: { close: number; sma50: number; sma20: number; structure: number; ext: number },
  atrRS: number,
): AtrAction {
  if (s.close < s.sma50) return "sell";
  if (s.close < s.sma20) return "reduce";
  if (s.structure >= 5 && s.ext >= 0 && s.ext <= 4 && atrRS >= 50) return "buy";
  return "hold";
}

// ─── per-ticker metrics from a Finviz row (no Polygon) ──────────────────────

/**
 * Metrics computed directly from a Finviz matrix row. Coarser than computeStock:
 * structure uses only the 20/50/200 SMAs and there is no prior-bar data, so
 * EMA10 is stood in by SMA20 and the reclaim actions are dropped (actionFinviz).
 */
export function computeFromFinviz(r: FinvizMatrixRow): StockCore | null {
  const { price, atr } = r;
  if (!(price > 0) || !(atr > 0)) return null;

  const atrPct = (100 * atr) / price;
  const sma50 = price / (1 + r.d50 / 100);
  const sma20 = price / (1 + r.d20 / 100);
  const sma200 = price / (1 + r.d200 / 100);
  const ext = (price - sma50) / atr;
  const bucket = extensionBucket(ext);

  // 6-point structure proxy (smaller %-distance = higher MA → d20≤d50 means SMA20≥SMA50)
  const structure =
    (r.d20 >= 0 ? 1 : 0) +
    (r.d50 >= 0 ? 1 : 0) +
    (r.d200 >= 0 ? 1 : 0) +
    (r.d20 <= r.d50 ? 1 : 0) +
    (r.d50 <= r.d200 ? 1 : 0) +
    (r.perfM >= 0 ? 1 : 0);

  const round2 = (x: number) => Math.round(x * 100) / 100;
  const ladder: Record<number, number> = {};
  for (const k of [7, 8, 9, 10, 11]) ladder[k] = round2(sma50 + k * atr);

  return {
    close: round2(price),
    chg: round2(r.change),
    atr: round2(atr),
    atrPct: round2(atrPct),
    ext: round2(ext),
    extPrev: round2(ext), // no prior-bar data
    bucket,
    zone: zoneForBucket(bucket),
    sma50: round2(sma50),
    sma20: round2(sma20),
    sma200: round2(sma200),
    structure,
    ema10: round2(sma20), // no EMA10 from Finviz
    ema10Prev: round2(sma20),
    sma20Prev: round2(sma20),
    prevClose: round2(price / (1 + r.change / 100)),
    dvol: Math.round((r.avgVol * price / 1e6) * 10) / 10,
    r1w: r.perfW / 100,
    r1m: r.perfM / 100,
    r3m: r.perfQ / 100,
    r6m: r.perfH / 100,
    aboveSMA50: r.d50 >= 0,
    stopSuggest: round2(price - 1.5 * atr),
    ladder,
    rvol: r.rvol,
    volWeek: round2(r.volWeek),
    avgVol: r.avgVol,
  };
}

// ─── universe-relative columns ──────────────────────────────────────────────

/** Percentile rank (0–100) matching pandas Series.rank(pct=True)*100 with the
 *  default 'average' tie method. */
function pctRank(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1].v === order[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank for the tie group
    for (let k = i; k <= j; k++) ranks[order[k].i] = (avgRank / n) * 100;
    i = j + 1;
  }
  return ranks;
}

/**
 * Add universe-relative columns: atrRS, rs (max of 1w/1m/3m/6m percentiles),
 * grade, action. All percentiles are relative to the scanned universe.
 */
type NamedCore = StockCore & { ticker: string; company: string; sector: string; industry: string; marketCap: number };

export function finalize(
  rows: NamedCore[],
  actionFn: (s: NamedCore, atrRS: number) => AtrAction = action,
): AtrStock[] {
  if (rows.length === 0) return [];

  const atrRSArr = pctRank(rows.map((r) => r.atrPct)).map((x) => Math.round(x));
  const p1w = pctRank(rows.map((r) => r.r1w));
  const p1m = pctRank(rows.map((r) => r.r1m));
  const p3m = pctRank(rows.map((r) => r.r3m));
  const p6m = pctRank(rows.map((r) => r.r6m));

  return rows.map((r, idx) => {
    const atrRS = atrRSArr[idx];
    const rs = Math.round(Math.max(p1w[idx], p1m[idx], p3m[idx], p6m[idx]));
    const grade = (LETTER[r.structure] ?? "G") + (rs >= 67 ? "+" : rs <= 33 ? "-" : "");
    return {
      ...r,
      atrRS,
      rs,
      grade,
      action: actionFn(r, atrRS),
    };
  });
}
