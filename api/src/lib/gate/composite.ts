// Ported from ShouldIBeTrading (api/src/lib/scoring/composite.ts).
// Thresholds, override rules and BOTH mode weight sets preserved exactly.

import type { MarketScoreResponse, TradingMode } from "./types.js";

export function computeDecision(
  qualityScore: number,
  volatilityScore: number,
  vixLevel: number,
  spyPrice: number,
  spyMa200: number,
  breadthScore: number,
): { decision: "YES" | "CAUTION" | "NO"; qualityScore: number } {
  let decision: "YES" | "CAUTION" | "NO";

  // Override rules
  if (vixLevel > 35) {
    return { decision: "NO", qualityScore: Math.min(qualityScore, 35) };
  }

  if (spyPrice < spyMa200 && breadthScore < 30) {
    return { decision: "NO", qualityScore: Math.min(qualityScore, 35) };
  }

  // Standard thresholds
  if (qualityScore >= 65) {
    decision = "YES";
  } else if (qualityScore >= 40) {
    decision = "CAUTION";
  } else {
    decision = "NO";
  }

  return { decision, qualityScore };
}

export function computeQualityScore(
  volatility: number,
  momentum: number,
  trend: number,
  breadth: number,
  macro: number,
  mode: TradingMode,
): number {
  // Day trading: volatility & momentum matter more (intraday moves)
  // Swing trading: trend & breadth matter more (multi-day positioning)
  if (mode === "day") {
    return Math.round(
      volatility * 0.30 +
      momentum * 0.30 +
      trend * 0.15 +
      breadth * 0.10 +
      macro * 0.15
    );
  }
  // Swing mode
  return Math.round(
    volatility * 0.20 +
    momentum * 0.20 +
    trend * 0.25 +
    breadth * 0.25 +
    macro * 0.10
  );
}

export type { MarketScoreResponse };
