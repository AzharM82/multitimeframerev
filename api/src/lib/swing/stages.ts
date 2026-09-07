/**
 * Swing Strength — Lens 3: Stan Weinstein's stage analysis, weekly, with the
 * sub-stages from the operator's spec ("gemini-code" prompt, 2026-09-05).
 *
 * Inputs per stock, all on WEEKLY bars (weeks end Friday):
 *   SMA30        30-week simple moving average of the close
 *   slope4w      % change of SMA30 over the last 4 weeks
 *   MRS          Mansfield relative strength vs the benchmark (SPY):
 *                RS = close / benchClose; MRS = (RS / SMA30(RS) − 1) × 100
 *   RVOL         this week's volume / 20-week volume SMA
 *   high52/low52 rolling 52-week bounds (the PRIOR 52 weeks, so a breakout is
 *                measured against history, not against itself)
 *
 * The spec's words that are not numbers are pinned here, in STAGES, and shown
 * on the tab — change them there, never inline:
 *   flat          |slope4w| ≤ FLAT_SLOPE_PCT  (0.5%)
 *   1A → 1B       base age ≥ BASE_MATURE_WEEKS (8) AND 8-week range ≤ TIGHT_RANGE_PCT
 *                 (20% of close) AND MRS > MRS_BASE_FLOOR (−1)
 *   2A → 2B       close > SMA30 × (1 + EXTENDED_PCT 15%) OR trend age > TREND_MATURE_WEEKS (16)
 *   3A → 3B       MRS < 0
 *   4A → 4B       trend age > TREND_MATURE_WEEKS OR close < SMA30 × (1 − EXTENDED_PCT)
 *   breakout      RVOL ≥ BREAKOUT_RVOL (1.5) and the weekly close is at/above
 *                 the prior 52-week high, this week or last
 *
 * Which flat stage (1 or 3) is decided by where the stock came from: the last
 * week whose slope was NOT flat, looked back up to LOOKBACK_WEEKS (26). A
 * falling slope before the flat = basing (Stage 1); a rising one = topping
 * (Stage 3). With no such week in range, price below SMA30 = 1, above = 3.
 * The two "crossed" cases (rising MA with price below it, falling MA with
 * price above it) are transitions: 3A off a Stage 2, 1A off a Stage 4.
 *
 * Pure functions; nothing here fetches.
 */

import type { WeeklyBar } from "./weekly.js";

export const STAGES = {
  SMA_WEEKS: 30,
  SLOPE_WEEKS: 4,
  FLAT_SLOPE_PCT: 0.5,
  RVOL_WEEKS: 20,
  HIGH_LOW_WEEKS: 52,
  BASE_MATURE_WEEKS: 8,
  TIGHT_RANGE_PCT: 20,
  MRS_BASE_FLOOR: -1.0,
  EXTENDED_PCT: 15,
  TREND_MATURE_WEEKS: 16,
  BREAKOUT_RVOL: 1.5,
  LOOKBACK_WEEKS: 26,
  /** Weeks of data needed before a stage is assigned. */
  MIN_WEEKS: 34,
  label: "Weekly · 30-wk SMA · 4-wk slope, flat = ±0.5% · Mansfield RS vs SPY · sub-stages per the spec",
} as const;

export type Stage = 1 | 2 | 3 | 4;
export type SubStage = "1A" | "1B" | "2A" | "2B" | "3A" | "3B" | "4A" | "4B";

export interface StageRead {
  stage: Stage | null;
  subStage: SubStage | null;
  /** Consecutive weeks in the current primary stage (including this week). */
  weeksInStage: number | null;
  weekEnd: string | null;
  weekComplete: boolean;
  close: number | null;
  sma30: number | null;
  /** % distance of the weekly close from SMA30. */
  distPct: number | null;
  slope4wPct: number | null;
  mrs: number | null;
  rvol: number | null;
  high52: number | null;
  low52: number | null;
  /** Close at/above the prior 52-week high with RVOL ≥ 1.5, this week or last. */
  breakout: boolean;
  /** Short reason string for the tab tooltip, e.g. "slope +1.2% · 9% over SMA30 · MRS +4". */
  why: string;
  weeks: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function smaAt(values: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += values[j];
  return s / n;
}

/** Primary stage for week i, given precomputed series. */
function primaryAt(close: number[], sma: (number | null)[], slope: (number | null)[], i: number): Stage | null {
  const s = sma[i], sl = slope[i];
  if (s === null || sl === null) return null;
  const above = close[i] > s;
  const flatBand = STAGES.FLAT_SLOPE_PCT;
  if (sl > flatBand && above) return 2;
  if (sl < -flatBand && !above) return 4;
  if (Math.abs(sl) <= flatBand) {
    // flat: where did it come from?
    for (let k = i - 1; k >= Math.max(0, i - STAGES.LOOKBACK_WEEKS); k--) {
      const ks = slope[k];
      if (ks === null) break;
      if (ks > flatBand) return 3;
      if (ks < -flatBand) return 1;
    }
    return above ? 3 : 1;
  }
  // crossed cases: rising MA / price below → early top; falling MA / price above → early base
  return sl > flatBand ? 3 : 1;
}

export function computeStage(stock: WeeklyBar[], bench: WeeklyBar[]): StageRead {
  const n = stock.length;
  const empty: StageRead = {
    stage: null, subStage: null, weeksInStage: null, weekEnd: n ? stock[n - 1].weekEnd : null,
    weekComplete: n ? stock[n - 1].complete : false, close: n ? stock[n - 1].close : null,
    sma30: null, distPct: null, slope4wPct: null, mrs: null, rvol: null, high52: null, low52: null,
    breakout: false, why: n < STAGES.MIN_WEEKS ? `only ${n} weeks of history` : "", weeks: n,
  };
  if (n < STAGES.MIN_WEEKS) return empty;

  const close = stock.map((w) => w.close);
  const sma: (number | null)[] = close.map((_, i) => smaAt(close, i, STAGES.SMA_WEEKS));
  const slope: (number | null)[] = sma.map((v, i) => {
    const prev = i - STAGES.SLOPE_WEEKS >= 0 ? sma[i - STAGES.SLOPE_WEEKS] : null;
    return v === null || prev === null || prev === 0 ? null : ((v - prev) / prev) * 100;
  });

  // Benchmark aligned by weekEnd (the benchmark may have a different first week).
  const benchByWeek = new Map(bench.map((w) => [w.weekEnd, w.close]));
  const rs: (number | null)[] = stock.map((w) => { const b = benchByWeek.get(w.weekEnd); return b ? w.close / b : null; });
  const rsClean = rs.map((v) => v ?? NaN);
  const mrsAt = (i: number): number | null => {
    if (i + 1 < STAGES.SMA_WEEKS) return null;
    let s = 0;
    for (let j = i - STAGES.SMA_WEEKS + 1; j <= i; j++) { if (Number.isNaN(rsClean[j])) return null; s += rsClean[j]; }
    const avg = s / STAGES.SMA_WEEKS;
    return avg === 0 || Number.isNaN(rsClean[i]) ? null : (rsClean[i] / avg - 1) * 100;
  };

  const last = n - 1;
  const vol = stock.map((w) => w.volume);
  const volSma = smaAt(vol, last, STAGES.RVOL_WEEKS);
  const rvol = volSma ? vol[last] / volSma : null;
  const priorHigh52 = (i: number) => { let h = -Infinity; for (let j = Math.max(0, i - STAGES.HIGH_LOW_WEEKS); j < i; j++) h = Math.max(h, stock[j].high); return Number.isFinite(h) ? h : null; };
  const priorLow52 = (i: number) => { let l = Infinity; for (let j = Math.max(0, i - STAGES.HIGH_LOW_WEEKS); j < i; j++) l = Math.min(l, stock[j].low); return Number.isFinite(l) ? l : null; };
  const h52 = priorHigh52(last), l52 = priorLow52(last);

  const stages: (Stage | null)[] = close.map((_, i) => primaryAt(close, sma, slope, i));
  const stage = stages[last];
  if (stage === null) return { ...empty, why: "SMA30 slope not yet defined" };
  let weeksInStage = 1;
  for (let k = last - 1; k >= 0 && stages[k] === stage; k--) weeksInStage++;

  const s30 = sma[last]!, sl = slope[last]!, dist = ((close[last] - s30) / s30) * 100, mrs = mrsAt(last);
  const rvolLast = rvol ?? 0;
  const breakoutNow = h52 !== null && close[last] >= h52 && rvolLast >= STAGES.BREAKOUT_RVOL;
  const prevVolSma = smaAt(vol, last - 1, STAGES.RVOL_WEEKS);
  const prevH52 = priorHigh52(last - 1);
  const breakoutPrev = prevH52 !== null && close[last - 1] >= prevH52 && prevVolSma !== null && vol[last - 1] / prevVolSma >= STAGES.BREAKOUT_RVOL;
  const breakout = stage === 2 && (breakoutNow || breakoutPrev);

  let sub: SubStage;
  if (stage === 1) {
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, last - STAGES.BASE_MATURE_WEEKS + 1); j <= last; j++) { hi = Math.max(hi, stock[j].high); lo = Math.min(lo, stock[j].low); }
    const rangePct = ((hi - lo) / close[last]) * 100;
    sub = weeksInStage >= STAGES.BASE_MATURE_WEEKS && rangePct <= STAGES.TIGHT_RANGE_PCT && (mrs ?? -99) > STAGES.MRS_BASE_FLOOR ? "1B" : "1A";
  } else if (stage === 2) {
    sub = dist > STAGES.EXTENDED_PCT || weeksInStage > STAGES.TREND_MATURE_WEEKS ? "2B" : "2A";
  } else if (stage === 3) {
    sub = (mrs ?? 0) < 0 ? "3B" : "3A";
  } else {
    sub = weeksInStage > STAGES.TREND_MATURE_WEEKS || dist < -STAGES.EXTENDED_PCT ? "4B" : "4A";
  }

  const why = [
    `slope ${sl >= 0 ? "+" : ""}${sl.toFixed(1)}%/4w`,
    `${dist >= 0 ? "+" : ""}${dist.toFixed(0)}% vs SMA30`,
    mrs === null ? "MRS n/a" : `MRS ${mrs >= 0 ? "+" : ""}${mrs.toFixed(0)}`,
    `${weeksInStage}w in stage`,
    breakout ? "BREAKOUT" : "",
  ].filter(Boolean).join(" · ");

  return {
    stage, subStage: sub, weeksInStage, weekEnd: stock[last].weekEnd, weekComplete: stock[last].complete,
    close: close[last], sma30: round2(s30), distPct: round2(dist), slope4wPct: round2(sl),
    mrs: mrs === null ? null : round2(mrs), rvol: rvol === null ? null : round2(rvol),
    high52: h52 === null ? null : round2(h52), low52: l52 === null ? null : round2(l52),
    breakout, why, weeks: n,
  };
}
