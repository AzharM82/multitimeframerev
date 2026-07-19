// Ported from ShouldIBeTrading (api/src/lib/scoring/posture.ts).
// Sizing / instrument / bias logic unchanged.
//
// calibration.ts and tradeLog.ts were NOT ported (trade journal starts empty
// and is out of scope). The Phase-4 adaptive step-down is kept intact but its
// input is now an OPTIONAL parameter: with no calibration supplied, nothing
// steps down and behaviour matches the rule-based baseline exactly.

import type { TradePosture } from "./types.js";

export interface PostureInput {
  decision: "YES" | "CAUTION" | "NO";
  executionScore: number;
  breadthScore: number;
  spyPrice: number;
  ma50: number;
  regime: string;
  rsi14: number;
  pctPositive: number;
  vixLevel: number;
  vixPercentile: number;
}

// ─── SIZE ──────────────────────────────────────────────────────────
// The habit-breaker. Conviction (decision) + whether setups are actually
// working (execution) + participation (breadth). Returns a % multiplier.
function computeSize(
  decision: "YES" | "CAUTION" | "NO",
  executionScore: number,
  breadthScore: number,
): { size: TradePosture["size"]; sizePct: number; note: string } {
  if (decision === "NO") {
    return { size: "NONE", sizePct: 0, note: "the go/no-go check failed" };
  }
  if (decision === "CAUTION") {
    if (executionScore < 45) {
      return { size: "QUARTER", sizePct: 25, note: "mixed signal and setups failing — smallest probe only" };
    }
    return { size: "HALF", sizePct: 50, note: "tradeable but unconfirmed — half size, quick partials" };
  }
  // decision === "YES"
  if (executionScore < 55) {
    return { size: "HALF", sizePct: 50, note: "good backdrop but breakouts not holding yet — don't front-run" };
  }
  if (breadthScore >= 55) {
    return { size: "FULL", sizePct: 100, note: "trend-day conditions: conviction, participation and follow-through" };
  }
  return { size: "HALF", sizePct: 50, note: "conditions good but participation is thin — keep it half" };
}

// ─── INSTRUMENT ────────────────────────────────────────────────────
// From the VIX / IV regime already computed (level + 1-yr percentile).
// Low IV → long options cheap; rich IV → sell premium via spreads.
function computeInstrument(
  vixLevel: number,
  vixPercentile: number,
  decision: "YES" | "CAUTION" | "NO",
): { instrument: TradePosture["instrument"]; note: string } {
  if (decision === "NO" || vixLevel > 30) {
    return { instrument: "CASH", note: "whipsaw risk too high for directional bets" };
  }
  if (vixLevel < 16 && vixPercentile < 40) {
    return { instrument: "OPTIONS", note: `VIX ${vixLevel.toFixed(1)} & low percentile — long options are cheap` };
  }
  if (vixLevel >= 22) {
    return { instrument: "SPREADS", note: `VIX ${vixLevel.toFixed(1)} — premium is rich, define risk with verticals` };
  }
  // 16–22, or low VIX but elevated percentile
  return { instrument: "STOCK", note: `VIX ${vixLevel.toFixed(1)} — options fairly priced, shares avoid theta/IV-crush` };
}

// ─── DIRECTION (market-regime bias) ────────────────────────────────
// Trade WITH the tape. Bullish → calls, bearish → puts, chop → neither.
function computeBias(
  price: number,
  ma50: number,
  regime: string,
  rsi14: number,
  pctPositive: number,
): { bias: TradePosture["bias"]; note: string } {
  // Stretched RSI = no fresh directional edge either way.
  if (rsi14 >= 80) {
    return { bias: "NEUTRAL", note: `RSI ${rsi14.toFixed(0)} is overbought/stretched — no fresh edge, stay nimble` };
  }

  let score = 0;
  score += price > ma50 ? 1 : -1;

  const r = regime.toLowerCase();
  if (r.includes("strong uptrend")) score += 2;
  else if (r.includes("uptrend")) score += 1;
  else if (r.includes("strong downtrend")) score -= 2;
  else if (r.includes("downtrend")) score -= 1;

  if (rsi14 >= 55 && rsi14 < 78) score += 1;
  else if (rsi14 < 45) score -= 1;

  if (pctPositive > 60) score += 1;
  else if (pctPositive < 40) score -= 1;

  if (score >= 2) {
    return { bias: "BULLISH", note: `tape is bullish (SPY ${price > ma50 ? ">" : "<"} 50-MA, ${regime}, RSI ${rsi14.toFixed(0)})` };
  }
  if (score <= -2) {
    return { bias: "BEARISH", note: `tape is bearish (SPY ${price > ma50 ? ">" : "<"} 50-MA, ${regime}, RSI ${rsi14.toFixed(0)})` };
  }
  return { bias: "NEUTRAL", note: `no directional edge (${regime}, RSI ${rsi14.toFixed(0)}) — stay nimble or sit` };
}

function biasToDirection(bias: TradePosture["bias"]): TradePosture["direction"] {
  if (bias === "BULLISH") return "CALLS";
  if (bias === "BEARISH") return "PUTS";
  return "NEITHER";
}

/**
 * Optional adaptive input. Omit it (the default) and no step-down is applied.
 * Wire the trade journal in later by passing the regime bucket for the current
 * mode + bias.
 */
export interface CalibrationInput {
  edge?: RegimeEdge;
  /** Minimum closed trades in the bucket before we trust its edge. */
  minSample?: number;
}

export const DEFAULT_MIN_SAMPLE = 10;

export function computePosture(input: PostureInput, calibration?: CalibrationInput): TradePosture {
  const sizeR = computeSize(input.decision, input.executionScore, input.breadthScore);
  const biasR = computeBias(
    input.spyPrice,
    input.ma50,
    input.regime,
    input.rsi14,
    input.pctPositive,
  );
  const instrR = computeInstrument(input.vixLevel, input.vixPercentile, input.decision);

  // If we're sitting out, direction is moot.
  const sittingOut = sizeR.size === "NONE";
  const direction = sittingOut ? "NEITHER" : biasToDirection(biasR.bias);

  // No directional thesis → don't commit full size. Cap at HALF and note why.
  let size = sizeR.size;
  let sizePct = sizeR.sizePct;
  let sizeNote = sizeR.note;
  if (!sittingOut && direction === "NEITHER" && size === "FULL") {
    size = "HALF";
    sizePct = 50;
    sizeNote = "backdrop is strong but there's no clear side — no full-size bet without a directional thesis";
  }

  // Confidence tracks size conviction, capped when direction has no edge.
  let confidence: TradePosture["confidence"];
  if (size === "FULL") confidence = "HIGH";
  else if (size === "HALF") confidence = "MEDIUM";
  else confidence = "LOW";
  if (biasR.bias === "NEUTRAL" && confidence === "HIGH") confidence = "MEDIUM";

  const headline = buildHeadline(size, direction, instrR.instrument, sittingOut);

  const rationale = sittingOut
    ? `Sit out — ${sizeNote}. ${cap(biasR.note)}.`
    : `${cap(biasR.note)} so ${direction === "NEITHER" ? "no directional lean" : `lean ${direction.toLowerCase()}`}. ${cap(instrR.note)}. Size: ${sizeNote}.`;

  const posture: TradePosture = {
    size,
    sizePct,
    instrument: instrR.instrument,
    direction,
    bias: biasR.bias,
    confidence,
    headline,
    rationale,
  };

  // No calibration supplied → rule-based baseline, unchanged.
  if (!calibration?.edge) return posture;
  return applyCalibration(posture, calibration.edge, calibration.minSample ?? DEFAULT_MIN_SAMPLE);
}

function buildHeadline(
  size: TradePosture["size"],
  direction: TradePosture["direction"],
  instrument: TradePosture["instrument"],
  sittingOut: boolean,
): string {
  if (sittingOut) return "SIT OUT · CASH";
  const dirLabel = direction === "NEITHER" ? "NO CLEAR SIDE" : direction;
  const instrLabel =
    instrument === "OPTIONS" ? "LONG OPTIONS"
    : instrument === "SPREADS" ? "SPREADS"
    : instrument === "STOCK" ? "SHARES"
    : "CASH";
  return `${size} SIZE · ${dirLabel} · ${instrLabel}`;
}

// ─── Phase 4: adaptive size blend ──────────────────────────────────
// Once a regime bucket has a real sample and a poor realized edge, step
// the recommended size down one notch. Rule-based stays the baseline
// until the evidence is there — we only ever downgrade for risk control.
const STEP_DOWN: Record<TradePosture["size"], { size: TradePosture["size"]; pct: number } | null> = {
  FULL: { size: "HALF", pct: 50 },
  HALF: { size: "QUARTER", pct: 25 },
  QUARTER: null, // already minimal
  NONE: null,
};

export interface RegimeEdge {
  count: number;
  winRate: number;
  avgPnl: number;
  edge: "GOOD" | "POOR" | "NEUTRAL" | "INSUFFICIENT";
}

export function applyCalibration(
  posture: TradePosture,
  edge: RegimeEdge | undefined,
  minSample: number = DEFAULT_MIN_SAMPLE,
): TradePosture {
  if (!edge || edge.count < minSample || edge.edge !== "POOR") return posture;
  const stepped = STEP_DOWN[posture.size];
  if (!stepped) return posture;

  const sittingOut = stepped.size === "NONE";
  return {
    ...posture,
    size: stepped.size,
    sizePct: stepped.pct,
    confidence: "LOW",
    headline: buildHeadline(stepped.size, posture.direction, posture.instrument, sittingOut),
    rationale:
      posture.rationale +
      ` Stepped down from your history: in this regime you're ${edge.count} trades, ${edge.winRate}% win, avg ${edge.avgPnl < 0 ? "−$" + Math.abs(edge.avgPnl) : "+$" + edge.avgPnl}/trade.`,
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
