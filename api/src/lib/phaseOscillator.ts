/**
 * Saty Phase Oscillator Engine
 * Ported from PineScript: Saty Phase Oscillator (Copyright 2022-2026 Saty Mahajan)
 *
 * Measures how far price is from its 21 EMA, normalized by ATR.
 * Includes Bollinger/Keltner compression detection and 4 zone crossover signals.
 */

import type { Candle } from "./indicators.js";
import { computeEMA, computeATR } from "./indicators.js";

export type PhaseZone =
  | "extended_up"
  | "distribution"
  | "neutral_up"
  | "launch_box"
  | "neutral_down"
  | "accumulation"
  | "extended_down";

export type PhaseSignal = "oversold" | "overbought" | null;

export type PhaseLineColor = "green" | "red" | "gray";

export type PhaseTimeframe = "1W" | "1D" | "60m" | "30m";

export interface PhaseTimeframeSignal {
  timeframe: PhaseTimeframe;
  oscillatorValue: number;
  zone: PhaseZone;
  signal: PhaseSignal;
  signalBarsAgo: number;
  compression: boolean;
  lineColor: PhaseLineColor;
}

export interface PhaseStockResult {
  ticker: string;
  price: number;
  score: number;
  signals: Record<PhaseTimeframe, PhaseTimeframeSignal>;
}

// ─── Scoring: +10 (max oversold/buy) to -10 (max overbought/sell) ───────────
// Weights: Weekly=4, Daily=3, 60m=2, 30m=1 → max ±10

const TF_WEIGHTS: Record<PhaseTimeframe, number> = { "1W": 4, "1D": 3, "60m": 2, "30m": 1 };

const ZONE_FACTORS: Record<PhaseZone, number> = {
  extended_down: 1.0,      // max oversold = +weight
  accumulation: 0.5,
  neutral_down: 0.25,
  launch_box: 0,
  neutral_up: -0.25,
  distribution: -0.5,
  extended_up: -1.0,       // max overbought = -weight
};

export function computePhaseScore(signals: Record<PhaseTimeframe, PhaseTimeframeSignal>): number {
  let score = 0;
  for (const tf of Object.keys(TF_WEIGHTS) as PhaseTimeframe[]) {
    const s = signals[tf];
    score += TF_WEIGHTS[tf] * ZONE_FACTORS[s.zone];
  }
  return Math.round(score * 10) / 10;
}

// ─── Standard Deviation (for Bollinger compression) ─────────────────────────

function computeStdDev(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j];
    }
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (values[j] - mean) ** 2;
    }
    result[i] = Math.sqrt(variance / period);
  }
  return result;
}

/**
 * Compute the Saty Phase Oscillator values for a series of candles.
 *
 * Formula (from PineScript L75, L120-121):
 *   pivot = EMA(close, 21)
 *   raw_signal = ((close - pivot) / (3.0 * ATR(14))) * 100
 *   oscillator = EMA(raw_signal, 3)
 */
export function computePhaseOscillator(candles: Candle[]): number[] {
  if (candles.length === 0) return [];

  const closes = candles.map((c) => c.close);
  const pivot = computeEMA(closes, 21);
  const atr = computeATR(candles, 14);

  const raw: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const atrVal = atr[i];
    if (atrVal === 0) {
      raw.push(0);
    } else {
      raw.push(((closes[i] - pivot[i]) / (3.0 * atrVal)) * 100);
    }
  }

  return computeEMA(raw, 3);
}

/**
 * Compute Bollinger/Keltner compression tracker.
 * From PineScript L86-103:
 *   compression = when Bollinger Bands squeeze inside Keltner Channel
 *   expansion requires: compression expanding bar-over-bar AND BB outside 1.854*ATR threshold
 */
export function computeCompression(candles: Candle[]): boolean[] {
  if (candles.length === 0) return [];

  const closes = candles.map((c) => c.close);
  const pivot = computeEMA(closes, 21);
  const atr = computeATR(candles, 14);
  const stdev = computeStdDev(closes, 21);

  const result: boolean[] = new Array(candles.length).fill(false);

  for (let i = 1; i < candles.length; i++) {
    const abovePivot = closes[i] >= pivot[i];
    const bbandOffset = 2.0 * stdev[i];
    const bbandUp = pivot[i] + bbandOffset;
    const bbandDown = pivot[i] - bbandOffset;
    const compThreshUp = pivot[i] + 2.0 * atr[i];
    const compThreshDown = pivot[i] - 2.0 * atr[i];
    const expThreshUp = pivot[i] + 1.854 * atr[i];
    const expThreshDown = pivot[i] - 1.854 * atr[i];

    const compression = abovePivot
      ? bbandUp - compThreshUp
      : compThreshDown - bbandDown;
    const inExpansionZone = abovePivot
      ? bbandUp - expThreshUp
      : expThreshDown - bbandDown;

    // Previous bar compression for expansion check
    const prevAbovePivot = closes[i - 1] >= pivot[i - 1];
    const prevBbandOffset = 2.0 * stdev[i - 1];
    const prevBbandUp = pivot[i - 1] + prevBbandOffset;
    const prevBbandDown = pivot[i - 1] - prevBbandOffset;
    const prevCompThreshUp = pivot[i - 1] + 2.0 * atr[i - 1];
    const prevCompThreshDown = pivot[i - 1] - 2.0 * atr[i - 1];
    const prevCompression = prevAbovePivot
      ? prevBbandUp - prevCompThreshUp
      : prevCompThreshDown - prevBbandDown;

    const expansion = prevCompression <= compression;

    if (expansion && inExpansionZone > 0) {
      result[i] = false;
    } else if (compression <= 0) {
      result[i] = true;
    } else {
      result[i] = false;
    }
  }

  return result;
}

/** Determine which zone an oscillator value falls into */
export function getZone(value: number): PhaseZone {
  if (value >= 100) return "extended_up";
  if (value >= 61.8) return "distribution";
  if (value >= 23.6) return "neutral_up";
  if (value <= -100) return "extended_down";
  if (value <= -61.8) return "accumulation";
  if (value <= -23.6) return "neutral_down";
  return "launch_box"; // -23.6 to 23.6
}

/**
 * Compute the phase oscillator signal for a given set of candles + timeframe.
 * Scans recent bars for all 4 crossover events (PineScript L125-128).
 */
export function getPhaseSignal(candles: Candle[], timeframe: PhaseTimeframe): PhaseTimeframeSignal {
  const empty: PhaseTimeframeSignal = {
    timeframe,
    oscillatorValue: 0,
    zone: "launch_box",
    signal: null,
    signalBarsAgo: -1,
    compression: false,
    lineColor: "green",
  };

  if (candles.length < 2) return empty;

  const osc = computePhaseOscillator(candles);
  const comp = computeCompression(candles);
  const currentValue = osc[osc.length - 1];
  const zone = getZone(currentValue);
  const compression = comp[comp.length - 1];

  // Line color: gray during compression, green when osc >= 0, red when < 0
  let lineColor: PhaseLineColor;
  if (compression) {
    lineColor = "gray";
  } else {
    lineColor = currentValue >= 0 ? "green" : "red";
  }

  // Look back up to 10 bars for a recent crossover signal
  let signal: PhaseSignal = null;
  let signalBarsAgo = -1;
  const lookback = Math.min(10, osc.length - 1);

  for (let i = 0; i < lookback; i++) {
    const idx = osc.length - 1 - i;
    const prev = osc[idx - 1];
    const curr = osc[idx];

    // Extreme crossovers only (PineScript L126, L128)
    // Oversold: leaving extreme down zone (-100 cross up) = buying opportunity
    if (prev <= -100 && curr > -100) {
      signal = "oversold";
      signalBarsAgo = i;
      break;
    }
    // Overbought: leaving extreme up zone (+100 cross down) = sell opportunity
    if (prev >= 100 && curr < 100) {
      signal = "overbought";
      signalBarsAgo = i;
      break;
    }
  }

  return {
    timeframe,
    oscillatorValue: Math.round(currentValue * 100) / 100,
    zone,
    signal,
    signalBarsAgo,
    compression,
    lineColor,
  };
}
