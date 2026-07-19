// Ported from ShouldIBeTrading (api/src/lib/scoring/trend.ts).
// Maths preserved exactly; local computeSMA() replaced by the shared helper.

import type { Candle, TrendData, CategoryScore, TradingMode } from "./types.js";
import { computeSMA } from "./constants.js";

function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gainSum += delta;
    else lossSum += Math.abs(delta);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function maPositionScore(price: number, ma20: number, ma50: number, ma200: number): number {
  if (price > ma20 && ma20 > ma50 && ma50 > ma200) return 100;
  if (price > ma50 && ma50 > ma200) return 75;
  if (price > ma200) return 50;
  if (ma50 > ma200) return 30;
  return 10;
}

function rsiScore(rsi: number): number {
  if (rsi >= 60 && rsi < 70) return 90;
  if (rsi >= 50 && rsi < 60) return 80;
  if (rsi >= 70 && rsi < 80) return 60;
  if (rsi >= 40 && rsi < 50) return 45;
  if (rsi >= 80) return 30;
  if (rsi >= 30 && rsi < 40) return 25;
  return 15;
}

function regimeScore(price: number, ma50: number, ma200: number, closes: number[]): { score: number; label: string } {
  // SMA50 slope: compare current SMA50 to SMA50 of 10 bars ago
  const recentCloses = closes.slice(-60);
  const currentSma50 = computeSMA(recentCloses, 50);
  const tenAgoCloses = recentCloses.slice(0, -10);
  const oldSma50 = tenAgoCloses.length >= 50 ? computeSMA(tenAgoCloses, 50) : currentSma50;
  const sma50Rising = currentSma50 > oldSma50;

  const sma200 = computeSMA(closes.slice(-210), 200);
  const oldSma200Closes = closes.slice(0, -10);
  const oldSma200 = oldSma200Closes.length >= 200 ? computeSMA(oldSma200Closes.slice(-210), 200) : sma200;
  const sma200Rising = sma200 > oldSma200;

  if (price > ma50 && price > ma200 && sma50Rising && sma200Rising) {
    return { score: 95, label: "Strong Uptrend" };
  }
  if (price > ma50 && sma50Rising) {
    return { score: 75, label: "Uptrend" };
  }
  const pctFromMa50 = Math.abs((price - ma50) / ma50) * 100;
  if (pctFromMa50 < 1.5) {
    return { score: 50, label: "Consolidation" };
  }
  if (price < ma50 && !sma50Rising) {
    if (price < ma200 && !sma200Rising) {
      return { score: 5, label: "Strong Downtrend" };
    }
    return { score: 25, label: "Downtrend" };
  }
  return { score: 50, label: "Mixed" };
}

function qqqScore(price: number, ma50: number): number {
  const pctDiff = ((price - ma50) / ma50) * 100;
  if (pctDiff > 0) return 80;
  if (pctDiff > -2) return 50;
  return 20;
}

export function computeTrendData(spyBars: Candle[], qqqBars: Candle[]): TrendData {
  const spyCloses = spyBars.map((b) => b.c);
  const qqqCloses = qqqBars.map((b) => b.c);

  const spyPrice = spyCloses[spyCloses.length - 1] ?? 0;
  const qqqPrice = qqqCloses[qqqCloses.length - 1] ?? 0;

  return {
    spy: {
      price: spyPrice,
      ma20: Math.round(computeSMA(spyCloses, 20) * 100) / 100,
      ma50: Math.round(computeSMA(spyCloses, 50) * 100) / 100,
      ma200: Math.round(computeSMA(spyCloses, 200) * 100) / 100,
      rsi14: computeRSI(spyCloses, 14),
      regime: "",
    },
    qqq: {
      price: qqqPrice,
      ma50: Math.round(computeSMA(qqqCloses, 50) * 100) / 100,
    },
  };
}

export function scoreTrend(data: TrendData, spyCloses: number[], _mode: TradingMode): CategoryScore & TrendData {
  const maScore = maPositionScore(data.spy.price, data.spy.ma20, data.spy.ma50, data.spy.ma200);
  const rsi = rsiScore(data.spy.rsi14);
  const regime = regimeScore(data.spy.price, data.spy.ma50, data.spy.ma200, spyCloses);
  const qqq = qqqScore(data.qqq.price, data.qqq.ma50);

  // Swing: MA position heavier. Day: more balanced
  const score = Math.round(maScore * 0.40 + rsi * 0.25 + regime.score * 0.20 + qqq * 0.15);

  const updatedData: TrendData = {
    ...data,
    spy: { ...data.spy, regime: regime.label },
  };

  let details: string;
  if (score >= 70) details = `${regime.label} — trend supports trading`;
  else if (score >= 45) details = `${regime.label} — mixed signals, be selective`;
  else details = `${regime.label} — trend is against you`;

  return {
    score,
    weight: 0.20,
    details,
    ...updatedData,
  };
}
