/**
 * Swing Strength — Lens 1: the moving-average stack, daily.
 *
 * Operator's definition (2026-09-05): 10 EMA above 20 EMA, 20 EMA above
 * 50 SMA, 50 SMA above 200 SMA. Three inequalities, each shown on its own so
 * a stock one day from stacking is visible, plus the percent distance from
 * price to each average.
 *
 *   stack = "bull"  all three hold
 *           "bear"  all three hold in reverse (10 < 20 < 50 < 200)
 *           "mixed" anything else
 *           "n/a"   fewer than 200 daily bars
 *
 * Pure functions on close arrays. The averages use every bar supplied, so
 * callers should pass at least ~260 trading days for a settled 200 SMA.
 */

export interface MaStack {
  close: number;
  ema10: number | null;
  ema20: number | null;
  sma50: number | null;
  sma200: number | null;
  /** % distance of price above (+) / below (−) each average. */
  d10: number | null;
  d20: number | null;
  d50: number | null;
  d200: number | null;
  /** The three inequalities, in order. null when an input average is missing. */
  c10over20: boolean | null;
  c20over50: boolean | null;
  c50over200: boolean | null;
  /** 0–3, number of inequalities that hold. */
  score: number;
  stack: "bull" | "bear" | "mixed" | "n/a";
  bars: number;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values (TOS / most charting
  // packages), then roll. A seed on the first close alone is what
  // lib/indicators.computeEMA does; on 500 bars the two agree to the cent,
  // on short histories they do not, so be explicit here.
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

const pct = (price: number, level: number | null) => (level === null || level === 0 ? null : round2(((price - level) / level) * 100));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeMaStack(closes: number[]): MaStack {
  const close = closes[closes.length - 1];
  const e10 = ema(closes, 10), e20 = ema(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const gt = (a: number | null, b: number | null) => (a === null || b === null ? null : a > b);
  const c1 = gt(e10, e20), c2 = gt(e20, s50), c3 = gt(s50, s200);
  const checks = [c1, c2, c3];
  const score = checks.filter((c) => c === true).length;
  let stack: MaStack["stack"];
  if (checks.some((c) => c === null)) stack = "n/a";
  else if (score === 3) stack = "bull";
  else if (e10! < e20! && e20! < s50! && s50! < s200!) stack = "bear";
  else stack = "mixed";
  return {
    close,
    ema10: e10 === null ? null : round2(e10), ema20: e20 === null ? null : round2(e20),
    sma50: s50 === null ? null : round2(s50), sma200: s200 === null ? null : round2(s200),
    d10: pct(close, e10), d20: pct(close, e20), d50: pct(close, s50), d200: pct(close, s200),
    c10over20: c1, c20over50: c2, c50over200: c3,
    score, stack, bars: closes.length,
  };
}
