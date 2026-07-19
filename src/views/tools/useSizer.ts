/**
 * Unified position-sizing calculation.
 *
 * Replaces three near-identical implementations that were scattered across the
 * standalone calculators:
 *   - "Rule Based Day Trading"       computeSizer()   — options, ×100 multiplier
 *   - "Rule Based Stock Day Trading" computeSizer()   — shares, ×1
 *   - "Position Management"          calculateFields() — shares, ×1
 *
 * All three share the same shape — take the smaller of a risk-derived quantity
 * and a capital-derived quantity — but they disagreed on two things that were
 * hardcoded rather than configurable:
 *
 *   1. The capital constraint. Rule Based sized against the FULL account;
 *      Position Management sized against capital/3 (a hardcoded 3 positions).
 *   2. The risk budget. Rule Based took an explicit dollar amount; Position
 *      Management derived it as 5% of the per-position allocation.
 *
 * Both are now explicit inputs (`positionCount`, `riskBudget`) so either
 * behaviour is reachable without a fork.
 *
 * NOTE — a bug deliberately not carried over: Position Management asked the user
 * for a risk percentage, then ignored it during sizing (it only fed a displayed
 * "risk amount"; sizing always used the hardcoded 5%). Here the risk budget you
 * supply is the risk budget that sizes the trade.
 */

export interface SizerInputs {
  /** Total account capital. */
  capital: number;
  /** How many concurrent positions the account is divided across. 1 = size against the whole account. */
  positionCount: number;
  /** Dollars you are willing to lose if the stop is hit. */
  riskBudget: number;
  /** Intended entry price, per share (not per contract). */
  entry: number;
  /** Stop-loss price, per share. */
  stop: number;
  /** Contract multiplier: 100 for options, 1 for shares. */
  multiplier: number;
}

export interface SizerResult {
  /** capital / positionCount — the capital this single trade may consume. */
  allocation: number;
  /** Dollar risk of one unit (share or contract) if stopped out. */
  riskPerUnit: number;
  /** Dollar cost to acquire one unit. */
  costPerUnit: number;
  /** Units affordable under the risk budget alone. */
  maxByRisk: number;
  /** Units affordable under the capital allocation alone. */
  maxByCapital: number;
  /** The binding constraint — which limit actually caps the trade. */
  limitedBy: "risk" | "capital" | "both" | "none";
  /** Final quantity: the smaller of the two constraints, floored at 0. */
  quantity: number;
  /** Dollar cost of the resulting position. */
  positionSize: number;
  /** Dollars at risk if stopped out, given `quantity`. */
  dollarsAtRisk: number;
  /** Fraction (0-1) of TOTAL capital at risk. Multiply by 100 for a percentage. */
  percentOfCapitalRisked: number;
  /** Allocation left unspent after this position. */
  capitalRemaining: number;
}

/** Coerce user input to a finite non-negative number. Blank fields become 0, never NaN. */
function toPositive(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function computeSizer(inputs: SizerInputs): SizerResult {
  const capital = toPositive(inputs.capital);
  const positionCount = Math.max(1, Math.floor(toPositive(inputs.positionCount)) || 1);
  const riskBudget = toPositive(inputs.riskBudget);
  const entry = toPositive(inputs.entry);
  const stop = toPositive(inputs.stop);
  const multiplier = Math.max(1, toPositive(inputs.multiplier) || 1);

  const allocation = capital / positionCount;

  // A stop above entry is nonsensical for a long; clamp to 0 rather than
  // returning a negative risk that would invert the sizing.
  const riskPerUnit = Math.max(0, entry - stop) * multiplier;
  const costPerUnit = entry * multiplier;

  const maxByRisk = riskPerUnit > 0 ? Math.floor(riskBudget / riskPerUnit) : 0;
  const maxByCapital = costPerUnit > 0 ? Math.floor(allocation / costPerUnit) : 0;

  const quantity = Math.max(0, Math.min(maxByRisk, maxByCapital));

  let limitedBy: SizerResult["limitedBy"] = "none";
  if (quantity > 0) {
    if (maxByRisk < maxByCapital) limitedBy = "risk";
    else if (maxByCapital < maxByRisk) limitedBy = "capital";
    else limitedBy = "both";
  }

  const positionSize = quantity * costPerUnit;
  const dollarsAtRisk = quantity * riskPerUnit;

  return {
    allocation,
    riskPerUnit,
    costPerUnit,
    maxByRisk,
    maxByCapital,
    limitedBy,
    quantity,
    positionSize,
    dollarsAtRisk,
    // Denominated against total capital, not the per-position allocation — "how
    // much of the account is on the line" is the question that actually matters.
    percentOfCapitalRisked: capital > 0 ? dollarsAtRisk / capital : 0,
    capitalRemaining: Math.max(0, allocation - positionSize),
  };
}
