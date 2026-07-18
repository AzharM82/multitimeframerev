/**
 * Shared numeric helpers ported from the MarketMetrics Python API.
 *
 * These back the cutoff-sensitive panels — 97 Club (`>= 0.97` on three
 * independent ranks) and Leading Industries / Thematics (top-20% slice). A
 * subtly different tie rule does not throw; it silently changes which tickers
 * appear, so the port is deliberately literal and covered by golden vectors in
 * `api/scripts/verify-stats.js`.
 *
 * Source: MarketMetrics `api/shared/calculations.py:_percentile_rank`
 *         (NaN semantics from `api/shared/data_fetcher.py:_isnan`)
 */

/**
 * Python's `_isnan`: `x is None or (isinstance(x, float) and x != x)`.
 * In TS the missing-value space is wider — null, undefined and NaN all mean
 * "no reading" and must rank below every real value.
 */
function isMissing(v: number | null | undefined): boolean {
  return v === null || v === undefined || Number.isNaN(v);
}

/**
 * Percentile rank in (0, 1] for each value, preserving input order.
 *
 * Ties share the average of their 0-based sorted positions, then the result is
 * shifted to 1-based: `(avgRank + 1) / n`. Missing values sort as `-Infinity`,
 * so they tie together at the bottom rather than being dropped — this keeps
 * `ranks[i]` aligned with `values[i]`, which every caller relies on.
 *
 * Note the Python docstring claims "NaN gets rank 0"; the implementation does
 * not do that, and the behaviour below matches the implementation, not the
 * docstring. A universe of all-missing values therefore ranks 1.0 throughout,
 * exactly as the original does.
 */
export function percentileRank(values: Array<number | null | undefined>): number[] {
  const n = values.length;
  if (n === 0) return [];

  // (originalIndex, sortKey) pairs — missing values become -Infinity so that
  // they compare equal to one another (NaN would not).
  const indexed: Array<[number, number]> = values.map((v, i) => [
    i,
    isMissing(v) ? Number.NEGATIVE_INFINITY : (v as number),
  ]);

  // Python's `sorted` is stable; Array.prototype.sort is too (ES2019+). Stability
  // is not strictly required here because ties are collapsed below, but keeping
  // it makes the two implementations byte-comparable when debugging.
  indexed.sort((a, b) => a[1] - b[1]);

  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    // Extend j across the run of values equal to sorted_pairs[i].
    let j = i;
    while (j < n - 1 && indexed[j + 1][1] === indexed[i][1]) {
      j += 1;
    }
    const avgRank = (i + j) / 2;
    for (let k = i; k <= j; k += 1) {
      ranks[indexed[k][0]] = (avgRank + 1) / n;
    }
    i = j + 1;
  }

  return ranks;
}

/**
 * Population standard-deviation normalisation used by the RRG panels:
 * `100 + (v - mean) / std * 10`.
 *
 * Divides by `n`, not `n - 1` — using the sample std would compress every
 * plotted point toward the centre. Zero variance collapses to std = 1 so a
 * flat input renders as a single point at 100 instead of dividing by zero.
 *
 * Source: MarketMetrics `calculations.py:_normalize` (duplicated there in
 * `compute_rrg_data` and `compute_thematics_rrg_data`).
 */
export function normalizeRrg(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];

  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const std = variance > 0 ? Math.sqrt(variance) : 1;

  return values.map((v) => 100 + ((v - mean) / std) * 10);
}

/**
 * Top-N slice size for a "top 20%" cut: `max(1, int(len * 0.2))`.
 *
 * `int()` truncates toward zero, which is `Math.floor` for the non-negative
 * lengths we ever pass. The `max(1, …)` floor means a short list still yields
 * one entry rather than an empty panel.
 */
export function topPercentCount(length: number, fraction = 0.2): number {
  return Math.max(1, Math.floor(length * fraction));
}
