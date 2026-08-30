/**
 * Credit-spread mathematics for the Options Strategy Guide tab.
 *
 * Two strategies, and only two:
 *
 *   FLOOR BET   (bull put credit spread)  — bet the stock stays ABOVE a line.
 *               SELL the higher-strike put, BUY the lower-strike put.
 *   CEILING BET (bear call credit spread) — bet it stays BELOW a line.
 *               SELL the lower-strike call, BUY the higher-strike call.
 *
 * Every number the operator sees comes from this file, including the payoff
 * diagram's vertices — the chart is drawn from the same arithmetic as the
 * breakdown, so the two can never disagree.
 *
 * PURE BY DESIGN. No I/O, no Date.now(), no module state. `api/src/app.ts`
 * never imports this; the HTTP handlers do the fetching and call in here. That
 * is what lets `api/tools/spread-math-test.mjs` exercise the real shipped
 * artefact with no network — the same reasoning recorded in avwapEarnings.ts,
 * where classifyCross/classifySlope are exported for exactly this purpose.
 *
 * ── Sign conventions, stated once ─────────────────────────────────────────
 * - Prices are PER SHARE. A contract is ×100; the *Contract helpers do that.
 * - Deltas arrive SIGNED: puts negative, calls positive. normDelta() takes the
 *   absolute value and rejects anything outside [0,1].
 * - A missing input yields null, never a default. `null` means "unknown" and
 *   must stay distinguishable from a real zero all the way to the screen —
 *   folding an unknown delta into 0 would quietly count it as "not rising"
 *   in the same way a dead VIX once scored as a calm tape.
 */

export type SpreadSide = "floor" | "ceiling";
export type CheckState = "pass" | "warn" | "fail" | "unknown";

/** Days to expiry the strategy is built for. Outside this the checklist fails. */
export const DTE_MIN = 28;
export const DTE_MAX = 60;
/** The sweeter part of that window — marked "ideal", but not required. */
export const DTE_IDEAL_MIN = 30;
export const DTE_IDEAL_MAX = 45;

/** Short-strike delta band ≈ 70–80% probability the strike is not breached. */
export const DELTA_MIN = 0.20;
export const DELTA_MAX = 0.30;
export const DELTA_TARGET = 0.25;

/** VIX regime the strategy assumes. Below: premium too thin. Above: whipsaw. */
export const VIX_MIN = 15;
export const VIX_MAX = 30;

/** Liquidity floor for a leg we intend to actually trade. */
export const MIN_OPEN_INTEREST = 100;
/** A bid/ask wider than this fraction of mid is a leg you will fight to fill. */
export const MAX_SPREAD_PCT = 0.10;

/** Protection widths offered by question 3. */
export const WIDTH_BASIC = 5;
export const WIDTH_FULL = 10;
export const WIDTH_MAX = 20;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r4 = (v: number) => Number(v.toFixed(4));
const r2 = (v: number) => Number(v.toFixed(2));

/**
 * |delta|, or null when the value cannot be trusted.
 *
 * Rejects — rather than repairs — malformed input:
 *   - |δ| > 1 is not a delta at all
 *   - a PUT with a positive delta means the feed's sign convention is not what
 *     we think it is; flipping it would silently invent a plausible number
 * Both cases return null so the UI renders n/a and the strike is excluded from
 * the recommendation, instead of being ranked on a fiction.
 */
export function normDelta(raw: unknown, type?: "put" | "call"): number | null {
  if (!isNum(raw)) return null;
  if (Math.abs(raw) > 1) return null;
  if (type === "put" && raw > 0) return null;
  if (type === "call" && raw < 0) return null;
  return r4(Math.abs(raw));
}

/** Distance between the legs, per share. Order-independent. */
export function width(shortStrike: unknown, longStrike: unknown): number | null {
  if (!isNum(shortStrike) || !isNum(longStrike)) return null;
  return r4(Math.abs(shortStrike - longStrike));
}

/**
 * Net credit at NATURAL prices — sell the short leg into the bid, pay the offer
 * on the long leg. The worst fill you can realistically expect, and therefore
 * the one every risk number is derived from: max loss and breakeven both move
 * the wrong way if the credit is flattered.
 */
export function creditNatural(shortBid: unknown, longAsk: unknown): number | null {
  if (!isNum(shortBid) || !isNum(longAsk)) return null;
  return r4(shortBid - longAsk);
}

/** Mid-to-mid credit. Shown alongside, never used for risk. */
export function creditMid(
  shortBid: unknown, shortAsk: unknown, longBid: unknown, longAsk: unknown,
): number | null {
  if (!isNum(shortBid) || !isNum(shortAsk) || !isNum(longBid) || !isNum(longAsk)) return null;
  return r4((shortBid + shortAsk) / 2 - (longBid + longAsk) / 2);
}

/** Max profit is the credit. Stated as a function so the card reads off one source. */
export function maxProfit(credit: number | null): number | null {
  return credit === null ? null : r4(credit);
}

/**
 * Max loss = width − credit.
 *
 * Deliberately NOT clamped at zero. A credit ≥ width implies risk-free profit,
 * which never means you found one — it means the quotes are stale or crossed.
 * Clamping would hide that behind a plausible number; returning it negative
 * lets the caller flag it and refuse the trade.
 */
export function maxLoss(w: number | null, credit: number | null): number | null {
  if (w === null || credit === null) return null;
  return r4(w - credit);
}

/**
 * The price at which the trade breaks even at expiry.
 *   floor   (bull put):  short strike − credit   (below the strike you sold)
 *   ceiling (bear call): short strike + credit   (above it)
 *
 * With a NEGATIVE credit (a debit) a floor's breakeven lands ABOVE the short
 * strike. That inversion is correct and is pinned in the tests, because a sign
 * error here produces a number that still looks entirely reasonable.
 */
export function breakeven(
  side: SpreadSide, shortStrike: unknown, credit: number | null,
): number | null {
  if (!isNum(shortStrike) || credit === null) return null;
  return r4(side === "floor" ? shortStrike - credit : shortStrike + credit);
}

/** Per-share → per-contract. One place, so the ×100 cannot drift. */
export function toContract(perShare: number | null): number | null {
  return perShare === null ? null : r2(perShare * 100);
}

/**
 * The payoff line, as exactly four vertices in ascending price order.
 *
 * Shipped in the API response and drawn verbatim, so the chart is not a second
 * implementation of the arithmetic that could disagree with the numbers beside
 * it. Returns [] when the spread is unpriced — a payoff drawn from a null
 * credit is precisely the invented-number hazard this tab must not have.
 */
export function payoffPoints(
  side: SpreadSide,
  shortStrike: number, longStrike: number,
  credit: number | null, domainLo: number, domainHi: number,
): { price: number; pl: number }[] {
  const w = width(shortStrike, longStrike);
  if (w === null || credit === null) return [];
  const profit = toContract(maxProfit(credit))!;
  const loss = -toContract(maxLoss(w, credit))!;
  const lo = Math.min(shortStrike, longStrike);
  const hi = Math.max(shortStrike, longStrike);
  // A floor bet loses to the downside and profits above; a ceiling bet mirrors.
  const left = side === "floor" ? loss : profit;
  const right = side === "floor" ? profit : loss;
  return [
    { price: r4(domainLo), pl: left },
    { price: r4(lo), pl: left },
    { price: r4(hi), pl: right },
    { price: r4(domainHi), pl: right },
  ];
}

// ─── Probability ────────────────────────────────────────────────────────────

/**
 * Headline win probability: 1 − |delta of the short leg|.
 *
 * Delta approximates the risk-neutral chance of finishing in the money, so this
 * is "the chance the strike you sold is not breached at expiry". It is the
 * number the 20–30 delta ≈ 70–80% rule of thumb refers to, and it is the
 * PESSIMISTIC of the two we show — see popAtBreakeven.
 */
export function popShort(shortDelta: unknown, type?: "put" | "call"): number | null {
  const d = normDelta(shortDelta, type);
  return d === null ? null : r4(1 - d);
}

/**
 * The better estimate: 1 − |delta interpolated to the BREAKEVEN price|.
 *
 * The spread is still profitable between the short strike and the breakeven, so
 * the true probability of profit is slightly better than popShort. Linear
 * interpolation of |delta| across the two chain strikes that bracket the
 * breakeven needs no extra data.
 *
 * Never extrapolates: a breakeven outside the bracketing pair returns null
 * rather than a number produced by running the line off its own ends.
 */
export function popAtBreakeven(
  be: number | null,
  lower: { strike: number; delta: number | null } | null,
  upper: { strike: number; delta: number | null } | null,
): number | null {
  if (be === null || !lower || !upper) return null;
  const dl = normDelta(lower.delta);
  const du = normDelta(upper.delta);
  if (dl === null || du === null) return null;
  if (!isNum(lower.strike) || !isNum(upper.strike)) return null;
  if (lower.strike === upper.strike) return null;
  if (be < Math.min(lower.strike, upper.strike)) return null;
  if (be > Math.max(lower.strike, upper.strike)) return null;
  const t = (be - lower.strike) / (upper.strike - lower.strike);
  return r4(1 - (dl + t * (du - dl)));
}

// ─── Strike selection ───────────────────────────────────────────────────────

export interface StrikeRow { strike: number; delta: number | null }

/**
 * The short strike implied by the operator's safety line.
 *
 *   floor   — the HIGHEST put strike at or below the line. Selling a put at or
 *             under the line is what "it stays above my line" means.
 *   ceiling — the LOWEST call strike at or above it.
 *
 * Inclusive on both: a line exactly on a strike selects that strike. A line
 * outside the chain returns null so the caller can say so, rather than being
 * silently clamped to the nearest available strike — which would answer a
 * different question from the one that was asked.
 */
export function pickShortStrike(
  side: SpreadSide, line: unknown, strikes: number[],
): number | null {
  if (!isNum(line) || !strikes.length) return null;
  const usable = strikes.filter(isNum).sort((a, b) => a - b);
  if (!usable.length) return null;
  if (side === "floor") {
    const at = usable.filter((k) => k <= line);
    return at.length ? at[at.length - 1] : null;
  }
  const at = usable.filter((k) => k >= line);
  return at.length ? at[0] : null;
}

/**
 * The protection leg, `targetWidth` away from the short strike.
 *
 * The strike grid rarely matches the target — a $7 target on a $5 grid gives an
 * actual width of $10 — so both numbers are returned and the UI must label from
 * widthActual. When the chain runs out before the target is reached the furthest
 * available strike is used and `widthShort` is set, so "you asked for $20 of
 * protection and $5 was all that existed" is visible rather than implied.
 */
export function pickLongStrike(
  side: SpreadSide, shortStrike: unknown, targetWidth: number, strikes: number[],
): { strike: number; widthTarget: number; widthActual: number; widthShort: boolean } | null {
  if (!isNum(shortStrike) || !isNum(targetWidth) || targetWidth <= 0) return null;
  const usable = strikes.filter(isNum).sort((a, b) => a - b);
  if (!usable.length) return null;

  if (side === "floor") {
    const want = shortStrike - targetWidth;
    const at = usable.filter((k) => k <= want && k < shortStrike);
    // Nothing far enough out: take the furthest strike below the short leg.
    const fallback = usable.filter((k) => k < shortStrike);
    const chosen = at.length ? at[at.length - 1] : (fallback.length ? fallback[0] : null);
    if (chosen === null) return null;
    const actual = r4(shortStrike - chosen);
    return { strike: chosen, widthTarget: targetWidth, widthActual: actual, widthShort: actual < targetWidth };
  }

  const want = shortStrike + targetWidth;
  const at = usable.filter((k) => k >= want && k > shortStrike);
  const fallback = usable.filter((k) => k > shortStrike);
  const chosen = at.length ? at[0] : (fallback.length ? fallback[fallback.length - 1] : null);
  if (chosen === null) return null;
  const actual = r4(chosen - shortStrike);
  return { strike: chosen, widthTarget: targetWidth, widthActual: actual, widthShort: actual < targetWidth };
}

/**
 * The strike this tool suggests as the safety line: closest to DELTA_TARGET
 * within [DELTA_MIN, DELTA_MAX].
 *
 * Ties break toward the LOWER delta — further out of the money, i.e. the safer
 * of two equally-close candidates. That is a deliberate bias and is asserted in
 * the tests rather than left to sort stability.
 *
 * When nothing sits in the band the nearest candidate is returned with
 * inBand:false, so the UI can offer it while saying it misses the target. With
 * no usable deltas at all the answer is null — never a strike picked by price
 * as if it had been picked by delta.
 */
export function recommendShort(
  rows: StrikeRow[],
): { strike: number; delta: number; inBand: boolean } | null {
  const usable = rows
    .map((r) => ({ strike: r.strike, d: normDelta(r.delta) }))
    .filter((r): r is { strike: number; d: number } => r.d !== null && isNum(r.strike));
  if (!usable.length) return null;

  const pick = (pool: { strike: number; d: number }[]) =>
    pool.reduce((best, cur) => {
      const db = Math.abs(best.d - DELTA_TARGET);
      const dc = Math.abs(cur.d - DELTA_TARGET);
      if (dc < db) return cur;
      if (dc > db) return best;
      return cur.d < best.d ? cur : best;   // tie → further OTM
    });

  const inBand = usable.filter((r) => r.d >= DELTA_MIN && r.d <= DELTA_MAX);
  if (inBand.length) {
    const w = pick(inBand);
    return { strike: w.strike, delta: w.d, inBand: true };
  }
  const w = pick(usable);
  return { strike: w.strike, delta: w.d, inBand: false };
}

// ─── Safety checklist ───────────────────────────────────────────────────────

export interface Check { state: CheckState; detail: string }

export function checkDte(dte: unknown): Check & { ideal: boolean } {
  if (!isNum(dte)) return { state: "unknown", detail: "expiry could not be read", ideal: false };
  const ideal = dte >= DTE_IDEAL_MIN && dte <= DTE_IDEAL_MAX;
  if (dte < DTE_MIN || dte > DTE_MAX) {
    return { state: "fail", detail: `${dte} days — outside the ${DTE_MIN}–${DTE_MAX} window`, ideal: false };
  }
  return { state: "pass", detail: ideal ? `${dte} days · ideal` : `${dte} days`, ideal };
}

/**
 * VIX gate.
 *
 * A DEGRADED reading can never pass. fetchVixData() sets degraded on its Yahoo
 * fallback as well as on a hard failure, so this is stricter than "the number
 * is missing" — and deliberately so: a VIX of 0 from a dead quote once scored
 * as a calm tape, which is the failure this rule exists to prevent. The zero
 * case is mapped to unknown BEFORE any threshold comparison runs.
 */
export function checkVix(level: unknown, degraded?: boolean): Check {
  if (!isNum(level) || level <= 0) return { state: "unknown", detail: "VIX unavailable" };
  if (degraded) return { state: "unknown", detail: `VIX ${r2(level)} — source degraded, not trusted` };
  if (level > VIX_MAX) return { state: "fail", detail: `VIX ${r2(level)} — above ${VIX_MAX}, whipsaw risk` };
  if (level < VIX_MIN) return { state: "warn", detail: `VIX ${r2(level)} — below ${VIX_MIN}, premium is thin` };
  return { state: "pass", detail: `VIX ${r2(level)}` };
}

export interface LegLiquidity {
  bid: number | null; ask: number | null; openInterest: number | null;
}

/** Both legs must be genuinely tradeable, not merely listed. */
export function checkLiquidity(short: LegLiquidity, long: LegLiquidity): Check {
  const twoSided = (l: LegLiquidity) => isNum(l.bid) && isNum(l.ask) && l.bid > 0 && l.ask > 0;
  if (!twoSided(short)) return { state: "fail", detail: "the leg you are selling has no bid" };
  if (!twoSided(long)) return { state: "fail", detail: "the protection leg has no offer" };
  if (!isNum(short.openInterest) || !isNum(long.openInterest)) {
    return { state: "unknown", detail: "open interest not reported" };
  }
  const thin = Math.min(short.openInterest, long.openInterest);
  const pct = (l: LegLiquidity) => {
    const mid = (l.bid! + l.ask!) / 2;
    return mid > 0 ? (l.ask! - l.bid!) / mid : Infinity;
  };
  const widest = Math.max(pct(short), pct(long));
  if (thin < MIN_OPEN_INTEREST) {
    return { state: "warn", detail: `open interest ${thin} — under ${MIN_OPEN_INTEREST}` };
  }
  if (widest > MAX_SPREAD_PCT) {
    return { state: "warn", detail: `bid/ask ${(widest * 100).toFixed(0)}% wide — work a limit order` };
  }
  return { state: "pass", detail: `OI ${thin} · spread ${(widest * 100).toFixed(0)}%` };
}

/**
 * Overall verdict. The manual "would I be happy owning it" box is not optional:
 * unticked, the checklist is INCOMPLETE regardless of how the automated rows
 * landed. The word "recommended" is deliberately never produced.
 */
export function verdict(checks: CheckState[], ownedAcknowledged: boolean): "PASS" | "REVIEW" | "FAIL" | "INCOMPLETE" {
  if (checks.includes("fail")) return "FAIL";
  if (!ownedAcknowledged) return "INCOMPLETE";
  if (checks.includes("warn") || checks.includes("unknown")) return "REVIEW";
  return "PASS";
}

/**
 * Whole-number days between two ET calendar dates (YYYY-MM-DD).
 *
 * Both parsed at noon UTC so a DST shift cannot move the difference by a day.
 * A past expiry returns a NEGATIVE number rather than 0 — the checklist should
 * say "-3 days" and fail, not silently show today.
 */
export function dteBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T12:00:00Z`);
  const b = Date.parse(`${toIso}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ─── Position sizing and exits ──────────────────────────────────────────────

/**
 * Take-profit rungs, as a fraction of max profit captured.
 *
 * 50% is the conventional close for a credit spread: the last half of the
 * premium takes the most time and carries the most gamma risk to collect, so
 * most of the edge is in the first half. The other rungs are there to show the
 * shape of that trade-off rather than to recommend one.
 */
export const CLOSE_TARGETS = [0.25, 0.50, 0.75, 1.00] as const;

/**
 * Stop rung: close if the spread costs this multiple of the credit to buy back.
 * At 2x, a loss equals the credit received — one loser cancels one winner held
 * to expiry, which is the arithmetic that makes the strategy legible.
 */
export const STOP_MULTIPLE = 2;

export interface CloseTarget {
  /** "50%" or "expire worthless" or "stop". */
  label: string;
  /** Fraction of max profit captured. Negative on the stop rung. */
  pctOfMax: number;
  /** What the SPREAD must be worth to close here, per share. */
  closePrice: number;
  /** Profit (or loss) per contract, in dollars. */
  pnlPerContract: number;
  /** pnl ÷ capital held, per contract. */
  returnOnCapital: number | null;
  isStop: boolean;
}

/**
 * What it takes to close, and what that leaves you.
 *
 * Deliberately independent of contract count: a close PRICE is per share
 * whatever size you trade, so the API ships this once per spread and the view
 * multiplies the dollar figures by the quantity. That keeps every genuine
 * options calculation here — the view only ever scales.
 *
 * You SOLD the spread for `credit`, so you close by BUYING it back cheaper:
 * capture 50% of max profit means buying it back for half the credit.
 */
export function closeLadder(credit: number | null, w: number | null): CloseTarget[] {
  if (credit === null || w === null || credit <= 0 || w <= 0) return [];
  const capital = w - credit;
  const roc = (pnl: number) => (capital > 0 ? r4(pnl / (capital * 100)) : null);

  const rungs: CloseTarget[] = CLOSE_TARGETS.map((pct) => {
    const closePrice = r2(credit * (1 - pct));
    const pnl = r2(credit * pct * 100);
    return {
      label: pct === 1 ? "expire worthless" : `${Math.round(pct * 100)}%`,
      pctOfMax: pct,
      closePrice,
      pnlPerContract: pnl,
      returnOnCapital: roc(pnl),
      isStop: false,
    };
  });

  // The spread can never be worth more than its width, so a 2x-credit stop on a
  // rich spread is really just max loss. Capping keeps the rung honest instead
  // of quoting a close price the market cannot print.
  const rawStop = credit * STOP_MULTIPLE;
  const stopPrice = r2(Math.min(rawStop, w));
  const stopPnl = r2((credit - stopPrice) * 100);
  rungs.push({
    label: rawStop >= w ? "stop (max loss)" : `stop (${STOP_MULTIPLE}x credit)`,
    pctOfMax: r4(stopPnl / (credit * 100)),
    closePrice: stopPrice,
    pnlPerContract: stopPnl,
    returnOnCapital: roc(stopPnl),
    isStop: true,
  });

  return rungs;
}

export interface Position {
  contracts: number;
  /** Cash the broker credits you on open. */
  creditReceived: number;
  /**
   * Buying power the broker holds until the position closes.
   *
   * This is the "cost" of a credit spread, and it is NOT a debit — you are paid
   * to open it. What you give up is the collateral, which equals the max loss
   * on a defined-risk vertical. Calling it a cost without saying which would
   * imply money leaving the account, and it does not.
   */
  capitalHeld: number;
  maxProfit: number;
  maxLoss: number;
  /** Max profit ÷ capital held. The number that makes sizes comparable. */
  returnOnCapital: number | null;
}

export function sizePosition(
  credit: number | null, w: number | null, contracts: number,
): Position | null {
  if (credit === null || w === null) return null;
  if (!Number.isFinite(contracts) || contracts < 1) return null;
  const n = Math.floor(contracts);
  const perContractLoss = (w - credit) * 100;
  const perContractProfit = credit * 100;
  return {
    contracts: n,
    creditReceived: r2(perContractProfit * n),
    capitalHeld: r2(perContractLoss * n),
    maxProfit: r2(perContractProfit * n),
    maxLoss: r2(perContractLoss * n),
    returnOnCapital: perContractLoss > 0 ? r4(perContractProfit / perContractLoss) : null,
  };
}

/**
 * How many contracts a risk budget buys.
 *
 * Floors, never rounds — rounding up would quietly put more at risk than the
 * budget allows, which is the one direction this must never err in. Returns 0
 * when even one contract exceeds the budget, so the caller can say "this trade
 * is too big for that number" rather than showing a 1 you cannot afford.
 */
export function contractsForRisk(maxLossPerContract: number | null, budget: number): number {
  if (maxLossPerContract === null || !Number.isFinite(budget)) return 0;
  if (maxLossPerContract <= 0 || budget <= 0) return 0;
  return Math.floor(budget / maxLossPerContract);
}

// ─── Single-leg (naked) variants ────────────────────────────────────────────
/**
 * Selling ONE option instead of a spread.
 *
 * You keep the whole premium instead of paying part of it away for the long
 * leg, so the credit is several times larger. What you give up is the long leg
 * itself — and that leg was the only thing capping the loss.
 *
 *   NAKED PUT  — loss is bounded, but only by the stock reaching zero.
 *                Max loss = (strike − credit) × 100. On a $305 put that is
 *                $30,425, against $400 on the equivalent $5-wide spread.
 *   NAKED CALL — loss is UNBOUNDED. There is no ceiling on the share price, so
 *                there is no worst case to quote. maxLoss returns null and
 *                every caller must render that as "unlimited", never as a
 *                number and never as zero.
 *
 * The honest comparison is not the credit, it is the return on capital: a
 * cash-secured put collects more dollars while tying up ~75x the collateral.
 */

/** Reg-T style naked-option margin, per share. An ESTIMATE — brokers differ. */
export function nakedMarginPerShare(
  spot: number, strike: number, credit: number, type: "put" | "call",
): number | null {
  if (!isNum(spot) || !isNum(strike) || !isNum(credit)) return null;
  if (spot <= 0 || strike <= 0) return null;
  const otm = type === "call" ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
  // The standard formula: premium + the greater of (20% of underlying less the
  // out-of-the-money amount) and 10% of the strike.
  const a = 0.20 * spot - otm;
  const b = 0.10 * strike;
  return r4(credit + Math.max(a, b));
}

/**
 * Worst case on a single short option, per share.
 *
 * Returns null for a CALL because the loss is genuinely unbounded — that null
 * means "no such number exists", which is different from "not computed yet",
 * and the UI must say unlimited rather than print anything.
 */
export function nakedMaxLoss(
  type: "put" | "call", strike: unknown, credit: number | null,
): number | null {
  if (type === "call") return null;
  if (!isNum(strike) || credit === null) return null;
  return r4(strike - credit);
}

/** Cash-secured put collateral, per share: the strike, less what you were paid. */
export function cashSecuredPerShare(strike: unknown, credit: number | null): number | null {
  if (!isNum(strike) || credit === null) return null;
  return r4(strike - credit);
}

/**
 * Payoff vertices for a single short option. Three points, and the outer one
 * keeps sloping — there is no flat floor, which is the whole visual difference
 * from a spread and the thing the operator most needs to see.
 */
export function payoffPointsSingle(
  type: "put" | "call", strike: number, credit: number | null,
  domainLo: number, domainHi: number,
): { price: number; pl: number }[] {
  if (credit === null || !isNum(strike)) return [];
  const keep = r2(credit * 100);
  if (type === "put") {
    return [
      { price: r4(domainLo), pl: r2((domainLo - strike + credit) * 100) },
      { price: r4(strike), pl: keep },
      { price: r4(domainHi), pl: keep },
    ];
  }
  return [
    { price: r4(domainLo), pl: keep },
    { price: r4(strike), pl: keep },
    { price: r4(domainHi), pl: r2((strike - domainHi + credit) * 100) },
  ];
}
