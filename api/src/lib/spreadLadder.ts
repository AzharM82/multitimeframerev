/**
 * Turns one option chain into the fully-costed spread ladders the tab renders.
 *
 * ── Why the server precomputes every row ──────────────────────────────────
 * Sliding the safety line has to feel instant, which argues for shipping the
 * raw chain and doing the arithmetic in the browser. But that would put a
 * second, untested copy of the credit / max-loss / breakeven math into TSX —
 * the exact duplication avwapEarnings.ts avoids by exporting classifyCross for
 * the test to reach.
 *
 * The ladder resolves both: the server enumerates every viable short strike,
 * pairs it with a long leg at each protection width, and returns each row
 * already costed. Moving the line is then an array lookup, the browser performs
 * no options arithmetic at all, and spreadMath.ts stays the only implementation
 * of every number the operator is shown.
 *
 * PURE — chain in, ladder out. No I/O, so the whole thing is reachable from a
 * plain .mjs test with a hand-built chain.
 */

import type { OptionChain, OptionContract } from "./optionsChain.js";
import {
  breakeven, creditMid, creditNatural, maxLoss, maxProfit, payoffPoints,
  pickLongStrike, pickShortStrike, popAtBreakeven, popShort, recommendShort,
  toContract, width, normDelta, closeLadder, type CloseTarget,
  WIDTH_BASIC, WIDTH_FULL, WIDTH_MAX,
  type SpreadSide,
} from "./spreadMath.js";

/**
 * Which strikes are worth costing at all.
 *
 * ±25% of spot bounds the payload; |δ| 0.05–0.50 is the band a credit spread is
 * actually sold in — below 0.05 the premium is not worth the risk, above 0.50
 * you are past the money and it is a different trade. 20 shorts per side keeps
 * 2 sides × 3 widths under ~120 rows (~35–50 KB).
 */
export const BAND_PCT = 0.25;
export const DELTA_FLOOR = 0.05;
export const DELTA_CEIL = 0.50;
export const MAX_SHORTS = 20;

export const WIDTHS = [WIDTH_BASIC, WIDTH_FULL, WIDTH_MAX] as const;

export interface LegQuote {
  strike: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface SpreadRow {
  side: SpreadSide;
  shortLeg: LegQuote;
  longLeg: LegQuote;
  widthTarget: number;
  widthActual: number;
  widthShort: boolean;
  credit: number | null;
  creditMid: number | null;
  maxProfit: number | null;
  maxLoss: number | null;
  maxProfitContract: number | null;
  maxLossContract: number | null;
  breakeven: number | null;
  popShort: number | null;
  popBreakeven: number | null;
  payoff: { price: number; pl: number }[];
  /**
   * What it takes to close, and what that leaves — PER CONTRACT.
   *
   * Size-independent on purpose: a close price is per share whatever quantity
   * you trade, so this ships once and the view multiplies the dollar figures by
   * the contract count. Every genuine options calculation stays in spreadMath.
   */
  closeTargets: CloseTarget[];
  viable: boolean;
  reason: string;
}

const legOf = (c: OptionContract): LegQuote => ({
  strike: c.strike, bid: c.bid, ask: c.ask,
  delta: c.delta, iv: c.iv, openInterest: c.openInterest, volume: c.volume,
});

/** Puts for a floor bet, calls for a ceiling bet. */
function legsFor(chain: OptionChain, side: SpreadSide): OptionContract[] {
  const want = side === "floor" ? "put" : "call";
  return chain.contracts
    .filter((c) => c.type === want)
    .sort((a, b) => a.strike - b.strike);
}

/**
 * Candidate short strikes: inside the price band, with a delta we can trust and
 * that sits in the sellable range. Strikes with no delta are excluded from
 * CANDIDACY but remain in the chain, so a user-chosen line can still land on
 * one — it simply never gets recommended.
 */
function shortCandidates(legs: OptionContract[], spot: number): OptionContract[] {
  const lo = spot * (1 - BAND_PCT);
  const hi = spot * (1 + BAND_PCT);
  const inBand = legs.filter((c) => {
    if (c.strike < lo || c.strike > hi) return false;
    const d = normDelta(c.delta, c.type);
    return d !== null && d >= DELTA_FLOOR && d <= DELTA_CEIL;
  });
  // Keep the ones nearest the money — those are the tradeable end of the band.
  return inBand
    .slice()
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, MAX_SHORTS)
    .sort((a, b) => a.strike - b.strike);
}

/**
 * Cost one spread completely.
 *
 * Every risk figure derives from `creditNatural` — sell the short leg into the
 * bid, pay the offer on the long leg. The mid-price credit is carried alongside
 * for display only: max loss and breakeven both move the wrong way if the
 * credit is flattered, and mid is not a fill you are guaranteed to get.
 */
export function buildRow(
  side: SpreadSide, shortC: OptionContract, longC: OptionContract,
  targetWidth: number, widthActual: number, widthShort: boolean,
  chainLegs: OptionContract[],
): SpreadRow {
  const w = width(shortC.strike, longC.strike);
  const credit = creditNatural(shortC.bid, longC.ask);
  const cMid = creditMid(shortC.bid, shortC.ask, longC.bid, longC.ask);
  const mp = maxProfit(credit);
  const ml = maxLoss(w, credit);
  const be = breakeven(side, shortC.strike, credit);

  let viable = true;
  let reason = "";
  if (credit === null) {
    viable = false;
    // Name WHICH leg failed — "no market" is not actionable, "the leg you are
    // selling has no bid" tells the operator to pick a different strike.
    if (shortC.bid === null || shortC.bid <= 0) reason = "short_not_bid";
    else if (longC.ask === null || longC.ask <= 0) reason = "long_not_offered";
    else reason = "no_two_sided_market";
  } else if (credit <= 0) {
    viable = false;
    reason = "no_credit";
  } else if (w !== null && credit >= w) {
    // Risk-free profit is never real. Surfaced, not clamped, so it reads as the
    // data fault it is rather than as an attractive trade.
    viable = false;
    reason = "credit_ge_width";
  }

  // Bracketing strikes for the breakeven, used for the better PoP estimate.
  let lower: { strike: number; delta: number | null } | null = null;
  let upper: { strike: number; delta: number | null } | null = null;
  if (be !== null) {
    for (const c of chainLegs) {
      if (c.strike <= be && (!lower || c.strike > lower.strike)) lower = { strike: c.strike, delta: c.delta };
      if (c.strike >= be && (!upper || c.strike < upper.strike)) upper = { strike: c.strike, delta: c.delta };
    }
  }

  const lo = Math.min(shortC.strike, longC.strike);
  const hi = Math.max(shortC.strike, longC.strike);
  const pad = Math.max(2 * (widthActual || 5), 0.04 * shortC.strike);

  return {
    side,
    shortLeg: legOf(shortC),
    longLeg: legOf(longC),
    widthTarget: targetWidth,
    widthActual,
    widthShort,
    credit,
    creditMid: cMid,
    maxProfit: mp,
    maxLoss: ml,
    maxProfitContract: toContract(mp),
    maxLossContract: toContract(ml),
    breakeven: be,
    popShort: popShort(shortC.delta, shortC.type),
    popBreakeven: popAtBreakeven(be, lower, upper),
    payoff: payoffPoints(side, shortC.strike, longC.strike, credit, lo - pad, hi + pad),
    closeTargets: closeLadder(credit, w),
    viable,
    reason,
  };
}

export interface Ladder {
  floor: Record<string, SpreadRow[]>;
  ceiling: Record<string, SpreadRow[]>;
  recommended: {
    floor: { strike: number; delta: number; inBand: boolean } | null;
    ceiling: { strike: number; delta: number; inBand: boolean } | null;
  };
  greeksAvailable: boolean;
  strikesWithoutGreeks: number;
}

export function buildLadder(chain: OptionChain): Ladder {
  const out: Ladder = {
    floor: {}, ceiling: {},
    recommended: { floor: null, ceiling: null },
    greeksAvailable: false,
    strikesWithoutGreeks: 0,
  };

  const withGreeks = chain.contracts.filter((c) => normDelta(c.delta, c.type) !== null);
  out.greeksAvailable = withGreeks.length > 0;
  out.strikesWithoutGreeks = chain.contracts.length - withGreeks.length;

  for (const side of ["floor", "ceiling"] as SpreadSide[]) {
    const legs = legsFor(chain, side);
    const strikes = legs.map((c) => c.strike);
    const byStrike = new Map(legs.map((c) => [c.strike, c]));
    const cands = shortCandidates(legs, chain.spot);

    out.recommended[side] = recommendShort(
      cands.map((c) => ({ strike: c.strike, delta: c.delta })),
    );

    for (const targetWidth of WIDTHS) {
      const rows: SpreadRow[] = [];
      for (const shortC of cands) {
        const long = pickLongStrike(side, shortC.strike, targetWidth, strikes);
        if (!long) continue;
        const longC = byStrike.get(long.strike);
        if (!longC) continue;
        rows.push(buildRow(side, shortC, longC, targetWidth, long.widthActual, long.widthShort, legs));
      }
      out[side][`w${targetWidth}`] = rows;
    }
  }

  return out;
}

/**
 * Resolve a user-typed safety line to a row already in the ladder.
 *
 * Returns null when the line falls outside the chain rather than clamping to
 * the nearest strike — a clamp silently answers a different question from the
 * one asked, and the operator would have no way to tell.
 */
export function rowForLine(
  ladder: Ladder, side: SpreadSide, targetWidth: number, line: number, strikes: number[],
): SpreadRow | null {
  const shortStrike = pickShortStrike(side, line, strikes);
  if (shortStrike === null) return null;
  const rows = ladder[side][`w${targetWidth}`] || [];
  return rows.find((r) => r.shortLeg.strike === shortStrike) ?? null;
}
