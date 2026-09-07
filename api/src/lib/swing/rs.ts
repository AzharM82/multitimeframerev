/**
 * Swing Strength — RS strength score (added 2026-09-06, operator request).
 *
 * The IBD-style relative strength rating: price performance over the last
 * year, weighted towards the most recent quarter, then ranked as a percentile
 * 1–99. IBD ranks against the whole market; here the rank is WITHIN the
 * operator's list (285 names), so 99 means "the strongest of these", not of
 * all stocks. The raw weighted return and the same figure for SPY are kept so
 * the tooltip can say how far ahead of the index a name is.
 *
 *   raw   = 2 × r63 + r126 + r189 + r252      (rN = close / close[N bars ago] − 1, in %)
 *   vsSpy = raw − raw(SPY)                     (percentage points)
 *   rank  = percentile of raw within the list, 1..99
 *
 * A name needs RS.MIN_BARS (252) daily bars; with fewer it has no score and is
 * left out of the ranking rather than ranked as the weakest.
 */

export const RS = {
  /** Trading days per quarter; the four windows are 1×, 2×, 3×, 4× this. */
  QUARTER_BARS: 63,
  /** Weight on the most recent quarter (the other three weigh 1). */
  RECENT_WEIGHT: 2,
  MIN_BARS: 252,
  label: "IBD-style weighted 12-month return (2×3m + 6m + 9m + 12m), ranked 1–99 within the list",
} as const;

export interface RsRead {
  /** Weighted 12-month return, %. */
  raw: number;
  /** Plain returns for the four windows, %. */
  r3m: number; r6m: number; r9m: number; r12m: number;
  /** raw − SPY's raw, percentage points; null when SPY was unavailable. */
  vsSpy: number | null;
  /** Percentile rank within the scanned list, 1..99; assigned after all rows are scored. */
  rank: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Return over the last n bars, %, or null with too little history / a zero base. */
export function returnOver(closes: number[], n: number): number | null {
  const i = closes.length - 1 - n;
  if (i < 0) return null;
  const base = closes[i];
  return base ? ((closes[closes.length - 1] - base) / base) * 100 : null;
}

/** The weighted 12-month return, or null with fewer than RS.MIN_BARS closes. */
export function rsRaw(closes: number[]): number | null {
  if (closes.length < RS.MIN_BARS) return null;
  const q = RS.QUARTER_BARS;
  const r3 = returnOver(closes, q), r6 = returnOver(closes, 2 * q), r9 = returnOver(closes, 3 * q), r12 = returnOver(closes, 4 * q);
  if (r3 === null || r6 === null || r9 === null || r12 === null) return null;
  return RS.RECENT_WEIGHT * r3 + r6 + r9 + r12;
}

export function computeRs(closes: number[], spyRaw: number | null): RsRead | null {
  const raw = rsRaw(closes);
  if (raw === null) return null;
  const q = RS.QUARTER_BARS;
  return {
    raw: round2(raw),
    r3m: round2(returnOver(closes, q)!), r6m: round2(returnOver(closes, 2 * q)!),
    r9m: round2(returnOver(closes, 3 * q)!), r12m: round2(returnOver(closes, 4 * q)!),
    vsSpy: spyRaw === null ? null : round2(raw - spyRaw),
    rank: null,
  };
}

/**
 * Percentile ranks 1..99 for a list of raw scores (nulls get null). A name's
 * rank is the share of the OTHER scored names it beats, scaled to 1..99, so the
 * weakest is 1 and the strongest 99 whether or not it is tied; equal scores
 * share a rank. All scores equal → 50.
 */
export function rankRs(raws: (number | null)[]): (number | null)[] {
  const scored = raws.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const n = scored.length;
  if (n === 0) return raws.map(() => null);
  if (n === 1) return raws.map((v) => (v === null ? null : 99));
  const bound = (x: number, strict: boolean) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (strict ? scored[m] < x : scored[m] <= x) lo = m + 1; else hi = m; } return lo; };
  return raws.map((v) => {
    if (v === null) return null;
    const below = bound(v, true), ties = bound(v, false) - below, others = n - ties;
    return others === 0 ? 50 : 1 + Math.round((98 * below) / others);
  });
}
