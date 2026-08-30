/**
 * Unit tests for the credit-spread mathematics that the Options Strategy Guide
 * puts in front of the operator as a trade to place. Run against the COMPILED
 * output, for the reason recorded in tools/tv-avwap/test_chart_js.mjs — a test
 * that exercises a hand-copied version of the logic passes happily while the
 * shipped artefact is broken.
 *
 *   cd api && npm run build && node tools/spread-math-test.mjs
 *
 * No Azure, no network, no storage: every function under test is pure.
 */
import {
  normDelta, width, creditNatural, creditMid, maxProfit, maxLoss, breakeven,
  toContract, payoffPoints, popShort, popAtBreakeven,
  pickShortStrike, pickLongStrike, recommendShort,
  checkDte, checkVix, checkLiquidity, verdict, dteBetween,
  closeLadder, sizePosition, contractsForRisk, CLOSE_TARGETS, STOP_MULTIPLE,
  nakedMaxLoss, cashSecuredPerShare, nakedMarginPerShare, payoffPointsSingle,
  DTE_MIN, DTE_MAX, DTE_IDEAL_MIN, DTE_IDEAL_MAX,
  DELTA_MIN, DELTA_MAX, DELTA_TARGET,
  VIX_MIN, VIX_MAX, MIN_OPEN_INTEREST, MAX_SPREAD_PCT,
  WIDTH_BASIC, WIDTH_FULL, WIDTH_MAX,
} from "../dist/lib/spreadMath.js";

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

// ── Width ──────────────────────────────────────────────────────────────────
// Order-independent, because the caller passes short/long in strategy order and
// a floor bet's long leg is BELOW its short while a ceiling bet's is above.

check("floor width", width(300, 295), 5);
check("ceiling width", width(300, 305), 5);
check("legs reversed still yields the same width", width(295, 300), 5);
check("a $2.50 grid works", width(302.5, 297.5), 5);
check("missing leg -> null", width(300, null), null);

// ── Core money math, both sides ────────────────────────────────────────────
// maxProfit is the credit; maxLoss is width minus it. These two lines are the
// whole trade, and every other number on the card hangs off them.

check("max profit is the credit", maxProfit(1.25), 1.25);
check("max loss is width minus credit", maxLoss(5, 1.25), 3.75);
check("profit per contract", toContract(maxProfit(1.25)), 125);
check("loss per contract", toContract(maxLoss(5, 1.25)), 375);

check("floor breakeven sits BELOW the short strike", breakeven("floor", 300, 1.25), 298.75);
check("ceiling breakeven sits ABOVE the short strike", breakeven("ceiling", 300, 1.25), 301.25);

// Mirrored trades must produce mirrored answers — if one branch is edited and
// the other is not, this is what catches it.
check("mirror: same width", width(300, 295) === width(300, 305), true);
check("mirror: same max loss",
  maxLoss(width(300, 295), 1.25) === maxLoss(width(300, 305), 1.25), true);

// ── Degenerate credits ─────────────────────────────────────────────────────
// None of these are errors. They are legitimate arithmetic on bad or unusual
// quotes, and each must be reported rather than suppressed — a strike that
// silently vanishes leaves the operator wondering why.

check("zero credit: max profit 0", maxProfit(0), 0);
check("zero credit: max loss is the full width", maxLoss(5, 0), 5);
check("zero credit: breakeven IS the short strike", breakeven("floor", 300, 0), 300);

// A DEBIT inverts the breakeven to the far side of the short strike. That is
// correct, and it is the single easiest sign error to ship unnoticed because
// the resulting number still looks entirely plausible.
check("debit on a floor: max loss exceeds the width", maxLoss(5, -0.3), 5.3);
check("debit on a floor: breakeven lands ABOVE the short strike",
  breakeven("floor", 300, -0.3), 300.3);
check("debit on a ceiling: breakeven lands BELOW the short strike",
  breakeven("ceiling", 300, -0.3), 299.7);

// Credit >= width implies risk-free profit. It never means you found one; it
// means the quotes are stale or crossed. Returned NEGATIVE and unclamped so the
// caller can refuse the trade instead of rendering a plausible small loss.
check("credit above width -> negative max loss, unclamped", maxLoss(5, 5.1), -0.1);
check("credit exactly the width -> zero max loss", maxLoss(5, 5), 0);

// ── Null discipline ────────────────────────────────────────────────────────
// Unknown must never collapse into a number. A NaN reaching the UI renders as
// "NaN"; a 0 reaching it renders as a real, tradeable-looking figure.

check("no short bid -> no credit", creditNatural(null, 2.7), null);
check("no long ask -> no credit", creditNatural(3.45, undefined), null);
check("null credit -> null max profit", maxProfit(null), null);
check("null credit -> null max loss", maxLoss(5, null), null);
check("null credit -> null breakeven", breakeven("floor", 300, null), null);
check("null per-share -> null per-contract", toContract(null), null);
check("natural credit off real AAPL quotes", creditNatural(3.45, 2.7), 0.75);
check("mid credit off the same quotes", creditMid(3.45, 3.7, 2.48, 2.7), 0.985);
check("mid credit with a missing leg", creditMid(3.45, 3.7, null, 2.7), null);

// ── Delta normalisation ────────────────────────────────────────────────────

check("put delta is made absolute", normDelta(-0.25, "put"), 0.25);
check("call delta passes through", normDelta(0.25, "call"), 0.25);
check("negative zero", normDelta(-0), 0);
check("delta of exactly 1 is allowed", normDelta(-1, "put"), 1);
check("delta beyond 1 is malformed", normDelta(1.4), null);
check("delta beyond -1 is malformed", normDelta(-1.4), null);
check("null delta", normDelta(null), null);
check("undefined delta", normDelta(undefined), null);
check("NaN delta", normDelta(NaN), null);
check("Infinite delta", normDelta(Infinity), null);
// A put quoted with a POSITIVE delta means the feed's sign convention is not
// what we assume. Flipping it would invent a plausible number from a broken one.
check("a put with a positive delta is rejected, not flipped", normDelta(0.25, "put"), null);
check("a call with a negative delta is rejected", normDelta(-0.25, "call"), null);

// ── Probability ────────────────────────────────────────────────────────────

check("popShort off a 24-delta short put", popShort(-0.24, "put"), 0.76);
check("popShort off a real -0.2523 delta", popShort(-0.2523, "put"), 0.7477);
check("popShort with no delta", popShort(null), null);
check("popShort on a malformed delta", popShort(1.4), null);

// Interpolating |delta| to the breakeven gives the better estimate, and it is
// always slightly kinder than popShort because breakeven sits past the strike.
check("popAtBreakeven interpolates between bracketing strikes",
  popAtBreakeven(298.75, { strike: 295, delta: -0.18 }, { strike: 300, delta: -0.26 }), 0.76);
check("popAtBreakeven is better than popShort at the same strike",
  popAtBreakeven(298.75, { strike: 295, delta: -0.18 }, { strike: 300, delta: -0.26 }) > popShort(-0.26),
  true);
// Never extrapolate — running the line off its own ends produces a number with
// no support in the data.
check("breakeven outside the bracket -> null",
  popAtBreakeven(280, { strike: 295, delta: -0.18 }, { strike: 300, delta: -0.26 }), null);
check("missing one bracket -> null",
  popAtBreakeven(298.75, null, { strike: 300, delta: -0.26 }), null);
check("a bracket with no delta -> null",
  popAtBreakeven(298.75, { strike: 295, delta: null }, { strike: 300, delta: -0.26 }), null);
check("degenerate bracket (same strike) -> null",
  popAtBreakeven(298.75, { strike: 300, delta: -0.2 }, { strike: 300, delta: -0.26 }), null);

// ── Short-strike selection from the safety line ────────────────────────────
// Selling a put at or BELOW the line is what "stays above my line" means; the
// ceiling case mirrors. Both bounds inclusive.

const GRID = [285, 290, 295, 300, 305, 310];

check("floor: line between strikes takes the one below", pickShortStrike("floor", 302.4, GRID), 300);
check("floor: line exactly on a strike takes it", pickShortStrike("floor", 295, GRID), 295);
check("floor: line under the whole chain", pickShortStrike("floor", 280, GRID), null);
check("ceiling: line between strikes takes the one above", pickShortStrike("ceiling", 302.4, GRID), 305);
check("ceiling: line exactly on a strike takes it", pickShortStrike("ceiling", 305, GRID), 305);
check("ceiling: line above the whole chain", pickShortStrike("ceiling", 400, GRID), null);
check("no line", pickShortStrike("floor", null, GRID), null);
check("empty chain", pickShortStrike("floor", 300, []), null);

// ── Long-strike selection ──────────────────────────────────────────────────
// The grid rarely matches the target width, so widthActual is what the UI must
// label from. widthShort marks "this is all the protection that existed".

check("floor $5 target on a $5 grid",
  pickLongStrike("floor", 300, 5, GRID), { strike: 295, widthTarget: 5, widthActual: 5, widthShort: false });
// A $7 target cannot be met on a $5 grid; the next strike out gives $10.
check("floor $7 target rounds OUT to $10, not in to $5",
  pickLongStrike("floor", 300, 7, GRID), { strike: 290, widthTarget: 7, widthActual: 10, widthShort: false });
check("ceiling $5 target",
  pickLongStrike("ceiling", 300, 5, GRID), { strike: 305, widthTarget: 5, widthActual: 5, widthShort: false });
check("chain runs out -> widthShort with what was available",
  pickLongStrike("floor", 300, 20, [295, 300]), { strike: 295, widthTarget: 20, widthActual: 5, widthShort: true });
check("no strike below the short leg at all", pickLongStrike("floor", 285, 5, [285, 290]), null);

// ── Recommendation ─────────────────────────────────────────────────────────

check("picks the in-band strike closest to the 0.25 target",
  recommendShort([
    { strike: 315, delta: -0.34 }, { strike: 310, delta: -0.28 },
    { strike: 305, delta: -0.22 }, { strike: 300, delta: -0.12 },
  ]),
  { strike: 305, delta: 0.22, inBand: true });
// 0.22 and 0.28 are both 0.03 from the target. The tie must resolve toward the
// LOWER delta — further out of the money — and not to whichever sorted first.
check("a tie breaks toward the safer (lower-delta) strike",
  recommendShort([{ strike: 310, delta: -0.28 }, { strike: 305, delta: -0.22 }]),
  { strike: 305, delta: 0.22, inBand: true });
check("nothing in band -> nearest, flagged out of band",
  recommendShort([{ strike: 315, delta: -0.31 }, { strike: 320, delta: -0.35 }]),
  { strike: 315, delta: 0.31, inBand: false });
check("band edges are inclusive (0.20)",
  recommendShort([{ strike: 300, delta: -0.20 }]), { strike: 300, delta: 0.2, inBand: true });
check("band edges are inclusive (0.30)",
  recommendShort([{ strike: 300, delta: -0.30 }]), { strike: 300, delta: 0.3, inBand: true });
check("just outside the band is out",
  recommendShort([{ strike: 300, delta: -0.1999 }]), { strike: 300, delta: 0.1999, inBand: false });
check("no usable deltas -> no recommendation",
  recommendShort([{ strike: 300, delta: null }, { strike: 305, delta: NaN }]), null);
check("empty ladder", recommendShort([]), null);

// ── Payoff vertices ────────────────────────────────────────────────────────
// The chart is drawn from these, so they must agree with maxProfit/maxLoss by
// construction rather than by a parallel calculation in the view.

check("floor payoff: loss on the left, profit on the right",
  payoffPoints("floor", 300, 295, 1.25, 280, 320),
  [{ price: 280, pl: -375 }, { price: 295, pl: -375 }, { price: 300, pl: 125 }, { price: 320, pl: 125 }]);
check("ceiling payoff mirrors it",
  payoffPoints("ceiling", 300, 305, 1.25, 280, 320),
  [{ price: 280, pl: 125 }, { price: 300, pl: 125 }, { price: 305, pl: -375 }, { price: 320, pl: -375 }]);
check("an unpriced spread draws nothing at all",
  payoffPoints("floor", 300, 295, null, 280, 320), []);

// ── Checklist ──────────────────────────────────────────────────────────────

check("DTE at the lower bound passes", checkDte(28).state, "pass");
check("DTE at the upper bound passes", checkDte(60).state, "pass");
check("DTE one short fails", checkDte(27).state, "fail");
check("DTE one long fails", checkDte(61).state, "fail");
check("DTE inside the ideal window is marked ideal", checkDte(34).ideal, true);
check("DTE in window but outside ideal is not", checkDte(50).ideal, false);
check("unreadable DTE is unknown", checkDte(null).state, "unknown");

check("VIX at the floor passes", checkVix(15).state, "pass");
check("VIX at the ceiling passes", checkVix(30).state, "pass");
check("VIX below the floor warns about thin premium", checkVix(14.9).state, "warn");
check("VIX above the ceiling fails", checkVix(30.1).state, "fail");
// The two rules that exist because a dead quote once scored as a calm tape.
check("a DEGRADED VIX can never pass", checkVix(18, true).state, "unknown");
check("VIX of exactly 0 is unknown, not a calm tape", checkVix(0).state, "unknown");
check("missing VIX is unknown", checkVix(null).state, "unknown");

const OK = { bid: 3.45, ask: 3.7, openInterest: 266 };
check("both legs liquid", checkLiquidity(OK, { bid: 2.48, ask: 2.7, openInterest: 644 }).state, "pass");
check("short leg with no bid cannot be sold",
  checkLiquidity({ bid: 0, ask: 3.7, openInterest: 266 }, OK).state, "fail");
check("long leg with no offer",
  checkLiquidity(OK, { bid: 2.48, ask: 0, openInterest: 644 }).state, "fail");
check("thin open interest warns",
  checkLiquidity(OK, { bid: 2.48, ask: 2.7, openInterest: 12 }).state, "warn");
check("a very wide market warns",
  checkLiquidity({ bid: 1.0, ask: 2.0, openInterest: 500 }, { bid: 0.9, ask: 1.0, openInterest: 500 }).state, "warn");
check("absent open interest is unknown, not zero",
  checkLiquidity(OK, { bid: 2.48, ask: 2.7, openInterest: null }).state, "unknown");

check("all clear and acknowledged", verdict(["pass", "pass", "pass"], true), "PASS");
check("any fail dominates everything", verdict(["pass", "fail", "warn"], true), "FAIL");
check("a fail beats an unticked box too", verdict(["fail"], false), "FAIL");
check("unticked box blocks a PASS", verdict(["pass", "pass"], false), "INCOMPLETE");
check("a warn downgrades to REVIEW", verdict(["pass", "warn"], true), "REVIEW");
check("an unknown downgrades to REVIEW", verdict(["pass", "unknown"], true), "REVIEW");

// ── Dates ──────────────────────────────────────────────────────────────────

check("DTE across a month boundary", dteBetween("2026-08-29", "2026-10-02"), 34);
check("DTE to a later expiry", dteBetween("2026-08-29", "2026-10-16"), 48);
check("same day", dteBetween("2026-08-29", "2026-08-29"), 0);
// A past expiry must read negative, so the checklist says "-3 days" and fails
// rather than silently presenting it as expiring today.
check("an expired contract is negative, not clamped", dteBetween("2026-08-29", "2026-08-26"), -3);
// Parsed at noon UTC so a DST transition cannot shift the answer by a day.
check("spans the US DST change without drifting", dteBetween("2026-10-30", "2026-11-06"), 7);
check("unparseable date", dteBetween("nonsense", "2026-10-02"), null);

// ── Shipped constants ──────────────────────────────────────────────────────
// Asserted at their exact values so a silent retune fails the suite instead of
// quietly changing what the tool recommends to the operator.

check("DTE window", [DTE_MIN, DTE_MAX], [28, 60]);
check("ideal DTE window", [DTE_IDEAL_MIN, DTE_IDEAL_MAX], [30, 45]);
check("delta band", [DELTA_MIN, DELTA_TARGET, DELTA_MAX], [0.2, 0.25, 0.3]);
check("VIX window", [VIX_MIN, VIX_MAX], [15, 30]);
check("liquidity floors", [MIN_OPEN_INTEREST, MAX_SPREAD_PCT], [100, 0.1]);
check("protection widths", [WIDTH_BASIC, WIDTH_FULL, WIDTH_MAX], [5, 10, 20]);

// ── ───────────────────────────────────────────────────────────────────────
// -- Position sizing -------------------------------------------------------
// A credit spread pays you to open, so there is no debit. What the broker takes
// is COLLATERAL equal to the max loss, and that is the number that limits how
// many you can hold. Conflating the two would imply money leaving the account.

check("one contract off the real AAPL spread",
  sizePosition(1.0, 5, 1),
  { contracts: 1, creditReceived: 100, capitalHeld: 400, maxProfit: 100, maxLoss: 400, returnOnCapital: 0.25 });
check("ten contracts scale linearly",
  sizePosition(1.0, 5, 10),
  { contracts: 10, creditReceived: 1000, capitalHeld: 4000, maxProfit: 1000, maxLoss: 4000, returnOnCapital: 0.25 });
// Return on capital is per-contract and therefore size-invariant. If it ever
// moves with quantity, the collateral maths has gone wrong.
check("return on capital does not move with size",
  sizePosition(1.0, 5, 1).returnOnCapital === sizePosition(1.0, 5, 37).returnOnCapital, true);
check("credit received equals max profit - you are paid up front",
  sizePosition(0.75, 5, 4).creditReceived, sizePosition(0.75, 5, 4).maxProfit);
check("fractional contracts floor, never round up", sizePosition(1.0, 5, 3.9).contracts, 3);
check("zero contracts is not a position", sizePosition(1.0, 5, 0), null);
check("negative contracts", sizePosition(1.0, 5, -2), null);
check("unpriced spread cannot be sized", sizePosition(null, 5, 1), null);

// -- Risk budget -> quantity -----------------------------------------------
// Floors ALWAYS. Rounding up would put more at risk than the budget allows,
// which is the one direction this must never err in.

check("$1000 budget at $400 risk buys 2", contractsForRisk(400, 1000), 2);
check("exact fit", contractsForRisk(500, 1000), 2);
check("one dollar short of the next contract still floors", contractsForRisk(400, 799), 1);
check("budget smaller than one contract buys none", contractsForRisk(400, 250), 0);
check("zero budget", contractsForRisk(400, 0), 0);
check("unpriced risk", contractsForRisk(null, 1000), 0);
check("a credit >= width has no positive risk to size against", contractsForRisk(-0.1, 1000), 0);

// -- Closing the position --------------------------------------------------
// You SOLD the spread, so you close by BUYING it back cheaper. Capturing 50% of
// max profit means buying it back for half what you received.

const L = closeLadder(1.0, 5);
check("four take-profit rungs plus a stop", L.length, 5);
check("50% rung: buy it back for half the credit",
  { close: L[1].closePrice, pnl: L[1].pnlPerContract }, { close: 0.5, pnl: 50 });
check("25% rung", { close: L[0].closePrice, pnl: L[0].pnlPerContract }, { close: 0.75, pnl: 25 });
check("75% rung", { close: L[2].closePrice, pnl: L[2].pnlPerContract }, { close: 0.25, pnl: 75 });
check("expiring worthless costs nothing to close and pays the lot",
  { close: L[3].closePrice, pnl: L[3].pnlPerContract, label: L[3].label },
  { close: 0, pnl: 100, label: "expire worthless" });
check("return on capital at the 50% rung", L[1].returnOnCapital, 0.125);
check("return on capital at expiry equals max profit / capital", L[3].returnOnCapital, 0.25);

const stop = L[4];
check("the stop is flagged as one", stop.isStop, true);
check("a 2x-credit stop loses exactly the credit received",
  { close: stop.closePrice, pnl: stop.pnlPerContract }, { close: 2, pnl: -100 });
check("stop label names the multiple", stop.label, "stop (2x credit)");
// One loser at the stop cancels one winner held to expiry. That symmetry is the
// arithmetic that makes the strategy legible, so it is pinned.
check("stop loss exactly offsets an expiry win",
  L[3].pnlPerContract + stop.pnlPerContract, 0);

// A spread can never be worth more than its width, so a 2x stop on a rich
// spread IS max loss. Quoting an uncappable close price would be a fiction.
const rich = closeLadder(3.0, 5);
const richStop = rich[4];
check("2x on a rich spread caps at the width", richStop.closePrice, 5);
check("and is relabelled as max loss", richStop.label, "stop (max loss)");
check("capped stop loses the max loss, not 2x the credit", richStop.pnlPerContract, -200);

check("an unpriced spread has no exits", closeLadder(null, 5), []);
check("a zero credit has no exits", closeLadder(0, 5), []);
check("a debit has no exits", closeLadder(-0.3, 5), []);

check("close targets are the shipped rungs", [...CLOSE_TARGETS], [0.25, 0.5, 0.75, 1]);
check("stop multiple", STOP_MULTIPLE, 2);

// -- Single leg (naked) ----------------------------------------------------
// Selling one option keeps the whole premium instead of paying part of it away
// for protection. The long leg was the only thing capping the loss, so removing
// it removes the cap - and for a CALL there is no cap at all.

// A naked put bottoms out at the stock reaching zero.
check("naked put worst case is the strike less the credit",
  nakedMaxLoss("put", 305, 4.80), 300.2);
check("...which is $30,020 per contract", toContract(nakedMaxLoss("put", 305, 4.80)), 30020);

// THE central fact about a naked call, and the one a number would misrepresent.
// null here means "no such value exists", not "not computed" - the UI must
// print "unlimited" rather than any figure at all.
check("a naked call has NO worst case - loss is unbounded",
  nakedMaxLoss("call", 340, 4.25), null);
check("that stays null however rich the premium", nakedMaxLoss("call", 340, 99), null);
check("null credit -> null, not a strike", nakedMaxLoss("put", 305, null), null);

check("cash-secured collateral is the strike less the credit",
  cashSecuredPerShare(305, 4.80), 300.2);
check("cash-secured with no credit", cashSecuredPerShare(305, null), null);

// The comparison that actually matters. The naked put collects 4.8x the credit
// of the $5-wide spread and ties up 75x the capital, so its return on capital
// is far WORSE. Selling more premium is not the same as making more money.
const spreadRoc = sizePosition(1.0, 5, 1).returnOnCapital;
const nakedCredit = 4.80;
const nakedCapital = cashSecuredPerShare(305, nakedCredit);
const nakedRoc = Number(((nakedCredit / nakedCapital)).toFixed(4));
check("the naked put collects more premium", nakedCredit > 1.0, true);
check("but its return on capital is far worse", nakedRoc < spreadRoc, true);
check("spread ROC", spreadRoc, 0.25);
check("naked put ROC", nakedRoc, 0.016);

// Reg-T naked margin: premium + max(20% of spot - OTM amount, 10% of strike).
check("naked margin on a 5% OTM put",
  nakedMarginPerShare(319.70, 305, 4.80, "put"), 54.04);
check("deep OTM falls back to the 10%-of-strike floor",
  nakedMarginPerShare(319.70, 200, 0.50, "put"), 20.5);
check("margin needs a real spot", nakedMarginPerShare(0, 305, 4.80, "put"), null);

// The payoff SLOPES at the outer edge instead of flattening. That missing floor
// is the entire visual difference from a spread.
const np = payoffPointsSingle("put", 305, 4.80, 280, 330);
check("naked put payoff has three vertices", np.length, 3);
check("it keeps the premium above the strike",
  { at: np[1].pl, far: np[2].pl }, { at: 480, far: 480 });
check("and is still falling at the left edge - no floor",
  np[0].pl, -2020);
const nc = payoffPointsSingle("call", 340, 4.25, 300, 380);
check("naked call keeps the premium below the strike", nc[1].pl, 425);
check("and is still falling at the right edge", nc[2].pl, -3575);
check("an unpriced single leg draws nothing", payoffPointsSingle("put", 305, null, 280, 330), []);

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${pass + failures.length}\n`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`PASS — ${pass} assertions (spread math + selection + checklist + sizing + exits + single leg)`);
