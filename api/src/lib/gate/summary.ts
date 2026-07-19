// Ported from ShouldIBeTrading (api/src/lib/scoring/summary.ts).
// Copy unchanged, plus two optional notes: stale FOMC data and degraded quotes,
// so a silent default or a dead feed is visible in the narrative.

import type { MarketScoreResponse } from "./types.js";

export function generateSummary(data: MarketScoreResponse): string {
  const parts: string[] = [];

  // Opening line
  if (data.decision === "YES") {
    parts.push(`Market conditions favor trading. Quality score: ${data.qualityScore}%.`);
  } else if (data.decision === "CAUTION") {
    parts.push(`Mixed signals — trade selectively. Quality score: ${data.qualityScore}%.`);
  } else {
    parts.push(`Market conditions unfavorable. Quality score: ${data.qualityScore}%. Consider sitting out.`);
  }

  // Find strongest and weakest categories
  const categories = [
    { name: "volatility", score: data.volatility.score },
    { name: "momentum", score: data.momentum.score },
    { name: "trend", score: data.trend.score },
    { name: "breadth", score: data.breadth.score },
    { name: "macro", score: data.macro.score },
  ].sort((a, b) => b.score - a.score);

  const strongest = categories[0];
  const weakest = categories[categories.length - 1];

  // Strength sentence
  const strengthMap: Record<string, string> = {
    volatility: `VIX at ${data.volatility.vix.level.toFixed(1)} supports ${data.volatility.vix.level < 18 ? "stable" : "manageable"} conditions.`,
    momentum: `${data.momentum.pctPositive > 70 ? "Broad" : "Selective"} sector participation with ${data.momentum.pctPositive}% positive.`,
    trend: `SPY is ${data.trend.spy.price > data.trend.spy.ma50 ? "above" : "below"} its 50-day MA. ${data.trend.spy.regime}.`,
    breadth: `${data.breadth.above200d}% of S&P 500 stocks above their 200-day MA.`,
    macro: `Macro backdrop is ${data.macro.score > 60 ? "supportive" : "neutral"}.`,
  };
  parts.push(strengthMap[strongest.name]);

  // Weakness warning
  if (weakest.score < 40) {
    const weakMap: Record<string, string> = {
      volatility: `Watch out: VIX at ${data.volatility.vix.level.toFixed(1)} signals elevated uncertainty.`,
      momentum: `Caution: Only ${data.momentum.pctPositive}% of sectors positive — narrow participation.`,
      trend: `Warning: SPY below key moving averages — trend is against you.`,
      breadth: `Red flag: Only ${data.breadth.above200d}% of stocks above 200-day MA — narrow market.`,
      macro: `Headwind: ${data.macro.fomcProximity.daysUntil <= 2 ? "FOMC meeting imminent" : "Macro conditions unfavorable"}.`,
    };
    parts.push(weakMap[weakest.name]);
  }

  // FOMC alert
  if (data.macro.fomcProximity.daysUntil <= 1) {
    parts.push(`FOMC ${data.macro.fomcProximity.isToday ? "concludes TODAY" : "concludes TOMORROW"} — expect elevated volatility.`);
  } else if (data.macro.fomcProximity.daysUntil <= 3) {
    parts.push(`FOMC meeting in ${data.macro.fomcProximity.daysUntil} days — position accordingly.`);
  }

  // Execution window
  if (data.execution.score >= 65) {
    parts.push(`Execution conditions favorable (${data.execution.score}%).`);
  } else if (data.execution.score < 40) {
    parts.push(`Execution conditions poor (${data.execution.score}%) — breakouts not holding.`);
  }

  // Mode note
  if (data.mode === "day") {
    parts.push("Day trading mode active — tighter thresholds applied.");
  }

  // Data-integrity notes (new — the source failed silently here)
  if (data.macro.fomcProximity.stale) {
    parts.push(
      `Note: the FOMC calendar ends ${data.macro.fomcProximity.dataThrough ?? "at the last hardcoded date"} — the macro sub-score is using a neutral default, not real meeting data.`,
    );
  }
  if (data.dataQuality?.degraded) {
    parts.push(`Data warning: ${data.dataQuality.warnings.join(" ")}`);
  }

  return parts.join(" ");
}
