/**
 * Opening Drive — daily levels (spec §PHASE 1 per-candidate fields).
 *
 * Pure functions over a daily-bar series that ends on the LAST COMPLETED session
 * before the scan/replay date. Keeping them pure means replay (historical) and
 * the live scan feed the same code — only the bar source differs.
 */

import type { Candle } from "../indicators.js";

export interface DailyLevels {
  priorClose: number;
  ydayHigh: number;
  atr14d: number;
  avgDailyVol30d: number;
  /** % distance from a reference price up to the nearest resistance above it. */
  distToResistancePct: number | null;
  ath: boolean;
}

/** Wilder's 14-day ATR from daily bars (needs >= 15 bars). */
export function atr14(daily: Candle[]): number {
  if (daily.length < 15) return 0;
  const trs: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const h = daily[i].high;
    const l = daily[i].low;
    const pc = daily[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder seed = simple average of first 14 TRs, then smoothed.
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < trs.length; i++) {
    atr = (atr * 13 + trs[i]) / 14;
  }
  return atr;
}

/**
 * Nearest significant resistance above `refPrice` from swing highs over a
 * lookback window, and whether `refPrice` is above every high in the window
 * (all-time-high within the lookback → treated as ATH per spec).
 *
 * A swing high is a bar whose high exceeds both neighbours; this filters intrabar
 * noise so "resistance" means a level price actually turned at.
 */
export function resistanceAbove(
  daily: Candle[],
  refPrice: number,
  lookback = 250,
): { distPct: number | null; ath: boolean } {
  const window = daily.slice(-lookback);
  if (window.length < 3) return { distPct: null, ath: false };

  const maxHigh = Math.max(...window.map((c) => c.high));
  if (refPrice >= maxHigh) return { distPct: null, ath: true };

  const swings: number[] = [];
  for (let i = 1; i < window.length - 1; i++) {
    if (window[i].high > window[i - 1].high && window[i].high > window[i + 1].high) {
      swings.push(window[i].high);
    }
  }
  // Fall back to the window max if no clean swing sits above the reference.
  const above = swings.filter((h) => h > refPrice);
  const nearest = above.length ? Math.min(...above) : maxHigh;
  return { distPct: ((nearest - refPrice) / refPrice) * 100, ath: false };
}

/**
 * Compute the daily levels. `refPrice` is the price the "room overhead" is
 * measured from (pm_last in the live scan; the replay uses the same field).
 */
export function computeLevels(daily: Candle[], refPrice: number): DailyLevels {
  const last = daily[daily.length - 1];
  const { distPct, ath } = resistanceAbove(daily, refPrice);
  const vol30 = daily.slice(-30);
  return {
    priorClose: last?.close ?? 0,
    ydayHigh: last?.high ?? 0,
    atr14d: atr14(daily),
    avgDailyVol30d: vol30.length
      ? vol30.reduce((s, c) => s + c.volume, 0) / vol30.length
      : 0,
    distToResistancePct: distPct,
    ath,
  };
}
