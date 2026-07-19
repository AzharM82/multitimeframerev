// Ported from ShouldIBeTrading (api/src/lib/scoring/macro.ts).
// Maths preserved exactly; local interpolate() replaced by the shared helper.
// Added: computeFomcProximity() now reports `stale` so the caller can surface
// the fact that FOMC_DATES has run out instead of silently scoring 85.

import type { Candle, MacroData, CategoryScore, TradingMode } from "./types.js";
import { FOMC_DATES, FOMC_DATA_THROUGH, isFomcDataStale, interpolate } from "./constants.js";

function computeTrend(bars: Candle[]): { change5d: number; trend: "rising" | "falling" | "flat" } {
  if (bars.length < 2) return { change5d: 0, trend: "flat" };

  const recent = bars.slice(-6);
  const current = recent[recent.length - 1].c;
  const fiveDaysAgo = recent[0].c;
  const change5d = fiveDaysAgo > 0 ? ((current - fiveDaysAgo) / fiveDaysAgo) * 100 : 0;

  let trend: "rising" | "falling" | "flat" = "flat";
  if (change5d > 1) trend = "rising";
  else if (change5d < -1) trend = "falling";

  return { change5d: Math.round(change5d * 100) / 100, trend };
}

// TNX is quoted as yield * 10 on Polygon (e.g. 45.2 = 4.52%)
// Rising yields = negative for stocks
function tnxTrendScore(change5dPct: number): number {
  // change5dPct is the % change in TNX value
  // Negative = yields falling = bullish
  return interpolate(-change5dPct, [
    [-5, 10],   // yields rising fast
    [-2, 25],
    [-0.5, 40],
    [0, 60],
    [0.5, 70],
    [2, 80],
    [5, 90],    // yields falling fast
  ]);
}

// Strong dollar generally negative for stocks
function dxyTrendScore(change5dPct: number): number {
  return interpolate(-change5dPct, [
    [-2.0, 15],   // DXY rising fast
    [-1.5, 35],
    [-0.5, 45],
    [0, 55],
    [0.5, 70],
    [1.5, 85],
    [2.0, 95],    // DXY falling fast
  ]);
}

function fomcProximityScore(daysUntil: number, mode: TradingMode): number {
  const dayTradeFloor = mode === "day" ? 10 : 20;

  if (daysUntil <= 0) return dayTradeFloor;
  if (daysUntil === 1) return 30;
  if (daysUntil <= 3) return 45;
  if (daysUntil <= 7) return 60;
  if (daysUntil <= 14) return 75;
  return 85;
}

export interface FomcProximity {
  daysUntil: number;
  nextDate: string;
  isToday: boolean;
  /** True when FOMC_DATES has no future entry left — the 85 default is a guess. */
  stale: boolean;
  /** Last FOMC date baked into the constants table. */
  dataThrough: string;
}

export function computeFomcProximity(): FomcProximity {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let closestDate = "";
  let closestDays = Infinity;

  for (const dateStr of FOMC_DATES) {
    const fomcDate = new Date(dateStr + "T00:00:00");
    const diff = Math.ceil((fomcDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (diff >= 0 && diff < closestDays) {
      closestDays = diff;
      closestDate = dateStr;
    }
  }

  return {
    daysUntil: closestDays === Infinity ? 999 : closestDays,
    nextDate: closestDate || "N/A",
    isToday: closestDays === 0,
    stale: isFomcDataStale(),
    dataThrough: FOMC_DATA_THROUGH,
  };
}

export function computeMacroData(tnxBars: Candle[], dxyBars: Candle[]): MacroData {
  const tnxTrend = computeTrend(tnxBars);
  const dxyTrend = computeTrend(dxyBars);
  const fomc = computeFomcProximity();

  return {
    tnx: {
      price: tnxBars.length > 0 ? Math.round(tnxBars[tnxBars.length - 1].c * 100) / 100 : 0,
      change5d: tnxTrend.change5d,
      trend: tnxTrend.trend,
    },
    dxy: {
      price: dxyBars.length > 0 ? Math.round(dxyBars[dxyBars.length - 1].c * 100) / 100 : 0,
      change5d: dxyTrend.change5d,
      trend: dxyTrend.trend,
    },
    fomcProximity: fomc,
  };
}

export function scoreMacro(data: MacroData, mode: TradingMode): CategoryScore & MacroData {
  const tnx = tnxTrendScore(data.tnx.change5d);
  const dxy = dxyTrendScore(data.dxy.change5d);
  const fomc = fomcProximityScore(data.fomcProximity.daysUntil, mode);

  const score = Math.round(tnx * 0.40 + dxy * 0.30 + fomc * 0.30);

  let details: string;
  if (data.fomcProximity.daysUntil <= 1) {
    details = `FOMC ${data.fomcProximity.isToday ? "TODAY" : "tomorrow"} — expect volatility`;
  } else if (score >= 65) {
    details = "Macro backdrop supportive";
  } else if (score >= 40) {
    details = "Macro conditions neutral";
  } else {
    details = "Macro headwinds — yields/dollar working against equities";
  }

  return {
    score,
    weight: 0.10,
    details,
    ...data,
  };
}
