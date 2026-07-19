// Ported from ShouldIBeTrading (api/src/lib/scoring/volatility.ts).
// Maths preserved exactly; local interpolate() replaced by the shared helper.

import type { Candle, VixData, CategoryScore } from "./types.js";
import { interpolate } from "./constants.js";

function vixLevelScore(vix: number): number {
  return interpolate(vix, [
    [10, 95],
    [12, 95],
    [15, 90],
    [18, 75],
    [22, 55],
    [28, 30],
    [35, 15],
    [50, 5],
  ]);
}

function vixTrendScore(change5dPercent: number): number {
  // Negative change = falling VIX = bullish
  return interpolate(-change5dPercent, [
    [-15, 10],   // VIX rising 15% = bad
    [-10, 25],
    [-5, 40],
    [0, 50],
    [5, 65],
    [10, 80],
    [15, 100],   // VIX falling 15% = great
  ]);
}

function vixPercentileScore(percentile: number): number {
  return interpolate(percentile, [
    [0, 95],
    [20, 90],
    [40, 75],
    [50, 55],
    [60, 45],
    [80, 25],
    [100, 10],
  ]);
}

export function computeVixPercentile(dailyBars: Candle[]): number {
  if (dailyBars.length < 20) return 50;

  const currentVix = dailyBars[dailyBars.length - 1].c;
  const lookback = dailyBars.slice(-252);
  const below = lookback.filter((b) => b.c < currentVix).length;
  return Math.round((below / lookback.length) * 100);
}

export function computeVixData(
  vixLevel: number,
  vixChange: number,
  dailyBars: Candle[],
): VixData {
  const bars = dailyBars.slice(-10);
  const fiveDaysAgo = bars.length >= 6 ? bars[bars.length - 6].c : bars[0]?.c ?? 0;
  const current = bars.length > 0 ? bars[bars.length - 1].c : vixLevel;
  const change5d = fiveDaysAgo > 0 ? ((current - fiveDaysAgo) / fiveDaysAgo) * 100 : 0;

  let trend: "rising" | "falling" | "flat" = "flat";
  if (change5d > 5) trend = "rising";
  else if (change5d < -5) trend = "falling";

  const percentile = computeVixPercentile(dailyBars);

  return {
    level: vixLevel || current,
    change: vixChange,
    trend,
    percentile,
    change5d,
  };
}

export function scoreVolatility(vix: VixData): CategoryScore & { vix: VixData } {
  const levelScore = vixLevelScore(vix.level);
  const trendScore = vixTrendScore(vix.change5d);
  const percentileScore = vixPercentileScore(vix.percentile);

  const score = Math.round(levelScore * 0.5 + trendScore * 0.25 + percentileScore * 0.25);

  let details: string;
  if (score >= 70) details = "Low volatility environment — favorable for trading";
  else if (score >= 45) details = "Moderate volatility — manageable with position sizing";
  else details = "Elevated volatility — high risk, reduce exposure";

  return {
    score,
    weight: 0.25,
    details,
    vix,
  };
}
