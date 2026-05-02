/**
 * Buy / Stop / Take-profit calculator — TS port of StockAgentHub stock_reversal.
 *
 * Algorithm (Brian Shannon-style modest swing):
 *   1. Find latest U1 (bullish reversal) in the daily bars.
 *   2. buy   = open of bar AFTER U1.  If U1 is the last bar (no next bar yet),
 *              fall back to the U1 bar's close.
 *   3. sl    = low of bar BEFORE U1 (i-2 from U1 in the original Python).
 *              If insufficient history, fall back to U1 bar's low.
 *   4. tp    = buy * (1 + STOCK_TP_PCT/100), default 5%.
 *
 * Reuses computeZigZag() from indicators.ts — same ThinkScript reversal logic
 * already proven across Reversal Scanner / Phase Oscillator.
 */

import type { Candle } from "./indicators.js";
import { computeZigZag } from "./indicators.js";

export interface Levels {
  ticker: string;
  entry: number;
  sl: number;
  tp: number;
  rPct: number;        // (tp - entry) / (entry - sl)
  reversalBarIdx: number;
  reversalBarTs: string;
  source: "u1_lookback" | "fallback_close";
}

const DEFAULT_TP_PCT = 5;

export function computeLevels(
  ticker: string,
  bars: Candle[],
  tpPct = DEFAULT_TP_PCT,
): Levels | null {
  if (bars.length < 5) return null;

  const zz = computeZigZag(bars);

  // Find the most recent U1 (bullish reversal)
  let u1Idx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (zz[i].U1) {
      u1Idx = i;
      break;
    }
  }

  // No U1 within current bar set — fall back to last close as entry, last 5-bar low as SL.
  if (u1Idx === -1) {
    const last = bars[bars.length - 1];
    const lookback = bars.slice(-5);
    const sl = Math.min(...lookback.map((b) => b.low));
    const entry = last.close;
    const tp = entry * (1 + tpPct / 100);
    return {
      ticker,
      entry: round2(entry),
      sl: round2(sl),
      tp: round2(tp),
      rPct: rMultiple(entry, sl, tp),
      reversalBarIdx: bars.length - 1,
      reversalBarTs: new Date(last.timestamp).toISOString(),
      source: "fallback_close",
    };
  }

  // SL = low of bar 2 before U1; clamp to first bar if not enough history.
  const slIdx = Math.max(0, u1Idx - 2);
  const sl = bars[slIdx].low;

  // Entry = open of bar AFTER U1; fallback to U1 close if U1 is the last bar.
  const entry = u1Idx + 1 < bars.length ? bars[u1Idx + 1].open : bars[u1Idx].close;
  const tp = entry * (1 + tpPct / 100);

  return {
    ticker,
    entry: round2(entry),
    sl: round2(sl),
    tp: round2(tp),
    rPct: rMultiple(entry, sl, tp),
    reversalBarIdx: u1Idx,
    reversalBarTs: new Date(bars[u1Idx].timestamp).toISOString(),
    source: "u1_lookback",
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rMultiple(entry: number, sl: number, tp: number): number {
  const risk = entry - sl;
  if (risk <= 0) return 0;
  return round2((tp - entry) / risk);
}
