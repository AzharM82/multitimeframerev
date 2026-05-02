/**
 * Anchored VWAP — Brian Shannon methodology
 *
 * AVWAP from anchor index `a`:
 *   numerator   += typical_price[i] * volume[i]    for i in [a, n]
 *   denominator += volume[i]                        for i in [a, n]
 *   avwap[i]    = numerator / denominator
 *
 * typical_price = (high + low + close) / 3
 */

import type { Candle } from "./indicators.js";

export type AnchorKind =
  | "ATH"
  | "52W_HIGH"
  | "52W_LOW"
  | "YTD"
  | "SWING_LOW";

export type PatternKind = "PULLBACK" | "PINCH" | "RECLAIM";

export interface Anchor {
  kind: AnchorKind;
  index: number;
  price: number;
  date: string;
}

export interface AvwapSeries {
  anchor: Anchor;
  values: number[]; // aligned to bars; values[i] = avwap at bar i (NaN before anchor)
}

export interface AvwapHit {
  ticker: string;
  pattern: PatternKind;
  price: number;
  score: number;
  involvedAnchors: AnchorKind[];
  bandPct: number;
  volumeMultiple: number;
  trendAligned: boolean;
  daysSinceTrigger: number;
  asOf: string;
  details: {
    avwapValues: Record<AnchorKind, number | null>;
    sma50: number | null;
    sma200: number | null;
    rsi14: number | null;
  };
}

// ─── AVWAP computation ──────────────────────────────────────────────────────

export function computeAVWAP(bars: Candle[], anchorIdx: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (anchorIdx < 0 || anchorIdx >= bars.length) return out;

  let cumPv = 0;
  let cumV = 0;
  for (let i = anchorIdx; i < bars.length; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    cumPv += tp * bars[i].volume;
    cumV += bars[i].volume;
    out[i] = cumV > 0 ? cumPv / cumV : NaN;
  }
  return out;
}

// ─── Anchor finders ──────────────────────────────────────────────────────────

const TRADING_DAYS_52W = 252;
const TRADING_DAYS_6M = 126;

function dateAt(bars: Candle[], idx: number): string {
  return new Date(bars[idx].timestamp).toISOString().split("T")[0];
}

function findAth(bars: Candle[]): Anchor | null {
  if (bars.length === 0) return null;
  let maxIdx = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i].high > bars[maxIdx].high) maxIdx = i;
  return { kind: "ATH", index: maxIdx, price: bars[maxIdx].high, date: dateAt(bars, maxIdx) };
}

function find52wHigh(bars: Candle[]): Anchor | null {
  if (bars.length === 0) return null;
  const start = Math.max(0, bars.length - TRADING_DAYS_52W);
  let maxIdx = start;
  for (let i = start + 1; i < bars.length; i++) if (bars[i].high > bars[maxIdx].high) maxIdx = i;
  return { kind: "52W_HIGH", index: maxIdx, price: bars[maxIdx].high, date: dateAt(bars, maxIdx) };
}

function find52wLow(bars: Candle[]): Anchor | null {
  if (bars.length === 0) return null;
  const start = Math.max(0, bars.length - TRADING_DAYS_52W);
  let minIdx = start;
  for (let i = start + 1; i < bars.length; i++) if (bars[i].low < bars[minIdx].low) minIdx = i;
  return { kind: "52W_LOW", index: minIdx, price: bars[minIdx].low, date: dateAt(bars, minIdx) };
}

function findYtdStart(bars: Candle[]): Anchor | null {
  if (bars.length === 0) return null;
  const year = new Date(bars[bars.length - 1].timestamp).getUTCFullYear();
  for (let i = 0; i < bars.length; i++) {
    if (new Date(bars[i].timestamp).getUTCFullYear() === year) {
      return { kind: "YTD", index: i, price: bars[i].open, date: dateAt(bars, i) };
    }
  }
  return null;
}

/**
 * Major swing low in past 6 months — lowest low excluding the most recent 5 bars
 * (we want a pivot that has had time to validate, not the current bar).
 */
function findSwingLow(bars: Candle[]): Anchor | null {
  if (bars.length < 10) return null;
  const end = bars.length - 5;
  const start = Math.max(0, end - TRADING_DAYS_6M);
  let minIdx = start;
  for (let i = start + 1; i < end; i++) if (bars[i].low < bars[minIdx].low) minIdx = i;
  return { kind: "SWING_LOW", index: minIdx, price: bars[minIdx].low, date: dateAt(bars, minIdx) };
}

export function findAllAnchors(bars: Candle[]): Anchor[] {
  return [findAth(bars), find52wHigh(bars), find52wLow(bars), findYtdStart(bars), findSwingLow(bars)]
    .filter((a): a is Anchor => a !== null);
}

// ─── Auxiliary indicators ────────────────────────────────────────────────────

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / 14;
  let avgLoss = loss / 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + Math.max(0, d)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(0, -d)) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function avgVol20(bars: Candle[]): number | null {
  if (bars.length < 20) return null;
  let sum = 0;
  for (let i = bars.length - 20; i < bars.length; i++) sum += bars[i].volume;
  return sum / 20;
}

// ─── Pattern detection ──────────────────────────────────────────────────────

interface DetectionContext {
  ticker: string;
  bars: Candle[];
  series: AvwapSeries[];
  closes: number[];
  lastBar: Candle;
  lastIdx: number;
  sma50: number | null;
  sma200: number | null;
  rsi: number | null;
  avgVolume: number | null;
}

function buildContext(ticker: string, bars: Candle[]): DetectionContext {
  const anchors = findAllAnchors(bars);
  const series: AvwapSeries[] = anchors.map((a) => ({ anchor: a, values: computeAVWAP(bars, a.index) }));
  const closes = bars.map((b) => b.close);
  const lastIdx = bars.length - 1;
  return {
    ticker,
    bars,
    series,
    closes,
    lastBar: bars[lastIdx],
    lastIdx,
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi: rsi14(closes),
    avgVolume: avgVol20(bars),
  };
}

function trendAligned(ctx: DetectionContext): boolean {
  if (ctx.sma50 === null || ctx.sma200 === null) return false;
  return ctx.lastBar.close > ctx.sma50 && ctx.sma50 > ctx.sma200 && (ctx.rsi ?? 50) >= 40 && (ctx.rsi ?? 50) <= 75;
}

function volumeMultiple(ctx: DetectionContext): number {
  if (!ctx.avgVolume || ctx.avgVolume === 0) return 1;
  return ctx.lastBar.volume / ctx.avgVolume;
}

function lastValues(ctx: DetectionContext): { kind: AnchorKind; value: number }[] {
  return ctx.series
    .map((s) => ({ kind: s.anchor.kind, value: s.values[ctx.lastIdx] }))
    .filter((v) => Number.isFinite(v.value));
}

function detailRecord(ctx: DetectionContext): AvwapHit["details"] {
  const out: Record<AnchorKind, number | null> = {
    ATH: null, "52W_HIGH": null, "52W_LOW": null, YTD: null, SWING_LOW: null,
  };
  for (const v of lastValues(ctx)) out[v.kind] = v.value;
  return { avwapValues: out, sma50: ctx.sma50, sma200: ctx.sma200, rsi14: ctx.rsi };
}

/**
 * PULLBACK — price within 1.5% of an anchor AVWAP, daily close above it,
 * broader trend up.
 */
function detectPullback(ctx: DetectionContext): AvwapHit | null {
  if (!trendAligned(ctx)) return null;
  const close = ctx.lastBar.close;
  const hits: { kind: AnchorKind; value: number }[] = [];
  for (const v of lastValues(ctx)) {
    const pct = ((close - v.value) / v.value) * 100;
    if (pct >= 0 && pct <= 1.5) hits.push(v);
  }
  if (hits.length === 0) return null;

  const tightestPct = Math.min(...hits.map((h) => Math.abs(((close - h.value) / h.value) * 100)));
  const volMult = volumeMultiple(ctx);

  return {
    ticker: ctx.ticker,
    pattern: "PULLBACK",
    price: close,
    score: scorePattern("PULLBACK", hits.length, tightestPct, volMult, true, 0),
    involvedAnchors: hits.map((h) => h.kind),
    bandPct: tightestPct,
    volumeMultiple: volMult,
    trendAligned: true,
    daysSinceTrigger: 0,
    asOf: dateAt(ctx.bars, ctx.lastIdx),
    details: detailRecord(ctx),
  };
}

/**
 * PINCH — 3+ AVWAPs converge within a 2% band (coiled spring).
 */
function detectPinch(ctx: DetectionContext): AvwapHit | null {
  const vals = lastValues(ctx);
  if (vals.length < 3) return null;

  const prices = vals.map((v) => v.value);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const mid = (max + min) / 2;
  const bandPct = ((max - min) / mid) * 100;
  if (bandPct > 2) return null;

  const volMult = volumeMultiple(ctx);
  const aligned = trendAligned(ctx);

  return {
    ticker: ctx.ticker,
    pattern: "PINCH",
    price: ctx.lastBar.close,
    score: scorePattern("PINCH", vals.length, bandPct, volMult, aligned, 0),
    involvedAnchors: vals.map((v) => v.kind),
    bandPct,
    volumeMultiple: volMult,
    trendAligned: aligned,
    daysSinceTrigger: 0,
    asOf: dateAt(ctx.bars, ctx.lastIdx),
    details: detailRecord(ctx),
  };
}

/**
 * RECLAIM — daily close reclaims an anchor AVWAP it was below for 5+
 * consecutive days.
 */
function detectReclaim(ctx: DetectionContext): AvwapHit | null {
  const close = ctx.lastBar.close;
  const reclaimed: { kind: AnchorKind; value: number }[] = [];

  for (const s of ctx.series) {
    const lastVal = s.values[ctx.lastIdx];
    if (!Number.isFinite(lastVal)) continue;
    if (close <= lastVal) continue;

    let belowDays = 0;
    for (let i = ctx.lastIdx - 1; i >= 0 && belowDays < 10; i--) {
      const v = s.values[i];
      if (!Number.isFinite(v)) break;
      if (ctx.bars[i].close < v) belowDays++;
      else break;
    }
    if (belowDays >= 5) reclaimed.push({ kind: s.anchor.kind, value: lastVal });
  }

  if (reclaimed.length === 0) return null;

  const tightestPct = Math.min(...reclaimed.map((h) => Math.abs(((close - h.value) / h.value) * 100)));
  const volMult = volumeMultiple(ctx);
  const aligned = trendAligned(ctx);

  return {
    ticker: ctx.ticker,
    pattern: "RECLAIM",
    price: close,
    score: scorePattern("RECLAIM", reclaimed.length, tightestPct, volMult, aligned, 0),
    involvedAnchors: reclaimed.map((r) => r.kind),
    bandPct: tightestPct,
    volumeMultiple: volMult,
    trendAligned: aligned,
    daysSinceTrigger: 0,
    asOf: dateAt(ctx.bars, ctx.lastIdx),
    details: detailRecord(ctx),
  };
}

// ─── Scoring (0-100) ────────────────────────────────────────────────────────

function scorePattern(
  pattern: PatternKind,
  involvedCount: number,
  bandPct: number,
  volMult: number,
  aligned: boolean,
  daysSinceTrigger: number,
): number {
  // Confluence (30): more anchors involved = higher
  const confluence = Math.min(30, involvedCount * 8);

  // Tightness (20): lower bandPct = higher
  const tightness = Math.max(0, 20 - bandPct * 10);

  // Volume (20): >=2x = full, scales linearly
  const volume = Math.min(20, Math.max(0, (volMult - 1) * 20));

  // Trend alignment (20)
  const trend = aligned ? 20 : 0;

  // Freshness (10): same day = 10, decays
  const fresh = Math.max(0, 10 - daysSinceTrigger * 2);

  // Pattern bias: pinch is rarer/stronger
  const bias = pattern === "PINCH" ? 5 : 0;

  return Math.round(Math.min(100, confluence + tightness + volume + trend + fresh + bias));
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function scanAvwap(ticker: string, bars: Candle[]): AvwapHit[] {
  if (bars.length < 60) return [];
  const ctx = buildContext(ticker, bars);
  const hits: AvwapHit[] = [];
  const pullback = detectPullback(ctx);
  if (pullback) hits.push(pullback);
  const pinch = detectPinch(ctx);
  if (pinch) hits.push(pinch);
  const reclaim = detectReclaim(ctx);
  if (reclaim) hits.push(reclaim);
  return hits;
}
