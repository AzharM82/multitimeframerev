/**
 * Swing Strength — consecutive-close streak (operator request 2026-09-08).
 *
 * How many daily bars in a row, ending at the last one, closed ABOVE the prior
 * close (positive) or BELOW it (negative). A flat last close is 0. Pure.
 *
 *   [10, 11, 12, 13]  →  3   (three green closes)
 *   [10,  9,  8]      → −2   (two red closes)
 *   [10, 11, 11]      →  0   (flat day breaks the run)
 */
export function closeStreak(closes: number[]): number {
  const n = closes.length;
  if (n < 2) return 0;
  const sign = Math.sign(closes[n - 1] - closes[n - 2]);
  if (sign === 0) return 0;
  let k = 0;
  for (let i = n - 1; i >= 1 && Math.sign(closes[i] - closes[i - 1]) === sign; i--) k++;
  return sign * k;
}
