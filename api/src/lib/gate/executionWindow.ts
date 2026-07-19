// Ported from ShouldIBeTrading (api/src/lib/scoring/executionWindow.ts). Maths unchanged.

import type { Candle, ExecutionData, CategoryScore } from "./types.js";

// Check if SPY closed above its prior 5-day high and held
function computeBreakoutsHolding(bars: Candle[]): number {
  if (bars.length < 7) return 50;

  const recent = bars.slice(-8);
  let breakouts = 0;
  let held = 0;

  for (let i = 5; i < recent.length - 1; i++) {
    // Prior 5-day high (excluding current bar)
    const prior5High = Math.max(...recent.slice(i - 5, i).map((b) => b.h));

    if (recent[i].c > prior5High) {
      breakouts++;
      // Check if next bar held above that level
      if (i + 1 < recent.length && recent[i + 1].c > prior5High * 0.998) {
        held++;
      }
    }
  }

  if (breakouts === 0) return 30; // No breakouts to evaluate
  const ratio = held / breakouts;
  if (ratio >= 0.8) return 100;
  if (ratio >= 0.6) return 75;
  if (ratio >= 0.4) return 50;
  return 30;
}

// Check if pullbacks (down days) are being bought the next day
function computePullbacksBought(bars: Candle[]): number {
  if (bars.length < 5) return 50;

  const recent = bars.slice(-6);
  let pullbacks = 0;
  let bought = 0;

  for (let i = 0; i < recent.length - 1; i++) {
    // Down day: close < open
    if (recent[i].c < recent[i].o) {
      pullbacks++;
      // Next day closes above the down day's open
      if (i + 1 < recent.length && recent[i + 1].c > recent[i].o) {
        bought++;
      }
    }
  }

  if (pullbacks === 0) return 70; // No pullbacks = continuous up, still decent
  if (bought >= 2) return 90;
  if (bought >= 1) return 65;
  return 25;
}

// Follow-through day: after 3+ declining days, a day with >1.5% gain
function computeFollowThrough(bars: Candle[]): number {
  if (bars.length < 5) return 50;

  const recent = bars.slice(-10);

  // Look for a 3+ day decline
  let declineStreak = 0;
  let declineEndIdx = -1;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].c < recent[i - 1].c) {
      declineStreak++;
    } else {
      if (declineStreak >= 3) {
        declineEndIdx = i;
      }
      declineStreak = 0;
    }
  }

  if (declineEndIdx === -1 && declineStreak < 3) {
    // No significant decline — market in uptrend
    return 70;
  }

  // Check for follow-through day after decline
  for (let i = Math.max(1, declineEndIdx); i < recent.length; i++) {
    const change = (recent[i].c - recent[i - 1].c) / recent[i - 1].c * 100;
    if (change > 1.5 && recent[i].v > recent[i - 1].v) {
      return 90; // Follow-through confirmed
    }
  }

  return 30; // Decline occurred but no follow-through
}

export function computeExecutionData(spyBars: Candle[]): ExecutionData {
  return {
    breakoutsHolding: computeBreakoutsHolding(spyBars),
    pullbacksBought: computePullbacksBought(spyBars),
    followThrough: computeFollowThrough(spyBars),
  };
}

export function scoreExecution(data: ExecutionData): CategoryScore & ExecutionData {
  const score = Math.round(
    data.breakoutsHolding * 0.40 +
    data.pullbacksBought * 0.35 +
    data.followThrough * 0.25
  );

  let details: string;
  if (score >= 70) details = "Setups are working — breakouts holding, dips being bought";
  else if (score >= 45) details = "Mixed execution — some breakouts failing";
  else details = "Poor execution window — breakouts failing, pullbacks not bought";

  return {
    score,
    weight: 0,
    details,
    ...data,
  };
}
