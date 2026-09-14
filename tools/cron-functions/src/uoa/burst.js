/**
 * Live burst detection — what counts as "something just happened".
 *
 * Pure functions, no I/O. The intraday engine polls every two minutes; this
 * file decides which of those poll-to-poll changes are worth showing.
 *
 * ── Why this is not the end-of-day rule ───────────────────────────────────
 * The EOD screen asks "how did the whole day compare with the open interest
 * that existed this morning". Cumulative volume only ever grows, so that ratio
 * crosses its threshold late in the session and says nothing about *when* the
 * activity happened. A name that traded steadily all day and a name that took
 * one enormous print at 10:14 look identical by the close.
 *
 * Live, the interesting quantity is the increment: contracts traded since the
 * last poll. A two-minute window that alone trades a large fraction of the
 * entire outstanding interest is somebody putting a position on right now, and
 * that is the thing worth seeing while it is still actionable.
 *
 * ── What cannot be done, and is therefore not claimed ─────────────────────
 * Open interest does NOT change intraday. OCC computes it overnight, so every
 * quote all day carries yesterday's settlement figure. A tab claiming to show
 * open interest "spiking" during the session would be inventing it. We use
 * yesterday's OI as the denominator — which is the right denominator, because
 * the question is how today's activity compares with the position that already
 * existed — and say plainly that it is yesterday's.
 *
 * Nor can volume be split into buys and sells. The tape reports a trade, not
 * who initiated it. What we can do is note where the contract's last print sits
 * against the quoted spread at the moment we sample: at or above the ask leans
 * bought, at or below the bid leans sold. That is a lean, not a fact, and it is
 * labelled that way everywhere it appears.
 */

"use strict";

const DEFAULT_BURST = {
  /** Contracts traded in one poll window before we look at all. */
  minLots: 250,
  /** Dollars committed in that window. Keeps penny contracts out. */
  minNotional: 50_000,
  /**
   * The window alone trades this share of the whole outstanding interest.
   *
   * A two-minute window, not a day: 15% of everything outstanding changing
   * hands inside two minutes is already a large, deliberate print. The first
   * draft asked for 35% and would have missed most real sweeps — a 5,000-lot
   * order into 20,000 open interest is exactly the thing this exists to catch
   * and only reaches 25%.
   */
  minOiShare: 0.15,
  /**
   * ...or the burst is simply enormous in money terms. A half-million dollars
   * committed inside two minutes is worth seeing whether or not the contract
   * happened to carry a large existing position.
   */
  bigNotional: 500_000,
  /** Below this open interest the share is not measurable. */
  oiFloor: 25,
  /** Ignore contracts priced under this — the spread swamps the signal. */
  minPrice: 0.1,
  /** How close to the quote a print must be to lean bought or sold. */
  sideTolerance: 0.02,
};

const round = (x, n) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(n)));

/**
 * Where the last print sits against the quote.
 *
 * Returns "bought" / "sold" / "mid" / null. Null when there is no usable quote
 * to judge against — an unknown lean, which the tab shows as unknown rather
 * than guessing "mid".
 */
function inferSide(last, bid, ask, tol = DEFAULT_BURST.sideTolerance) {
  if (last === null || last === undefined) return null;
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || ask < bid) return null;
  const width = ask - bid;
  // A locked or crossed market carries no information about who crossed.
  if (width <= 0) return null;
  const slack = Math.max(tol, width * 0.1);
  if (last >= ask - slack) return "bought";
  if (last <= bid + slack) return "sold";
  return "mid";
}

/**
 * Compare one contract between two polls.
 *
 * `prev` is the previous poll's row for the same contract, or undefined on the
 * first poll of the day. A contract seen for the first time is measured from
 * zero, which is correct: everything it has traded is new since we started.
 */
function burstFor(now, prev, meta, cfg = DEFAULT_BURST) {
  const dayVolume = now.volume || 0;
  const before = prev ? prev.volume || 0 : 0;
  // Volume is cumulative and must never go backwards. If it does, the session
  // rolled over (or the feed hiccuped) — treat it as a fresh start, not as a
  // negative burst.
  const lots = dayVolume >= before ? dayVolume - before : dayVolume;
  if (lots < cfg.minLots) return null;

  const price = now.last ?? null;
  if (price === null || price < cfg.minPrice) return null;

  const notional = lots * price * 100;
  if (notional < cfg.minNotional) return null;

  const oi = meta.priorOi;
  if (oi === null || oi === undefined || oi < cfg.oiFloor) return null;
  const oiShare = lots / oi;
  // Either the burst is large relative to the position that already existed,
  // or it is large in absolute money. Requiring both would silently drop the
  // biggest prints in the most liquid names, which are the ones that matter.
  if (oiShare < cfg.minOiShare && notional < cfg.bigNotional) return null;

  return {
    occ_symbol: meta.occSymbol,
    underlying: meta.underlying,
    type: meta.type,
    strike: meta.strike,
    expiry: meta.expiry,
    dte: meta.dte,
    /** Contracts traded in THIS window — the whole point of the live view. */
    lots,
    notional: round(notional, 2),
    /** Cumulative for the session, for context. */
    day_volume: dayVolume,
    prior_oi: oi,
    /** This window as a share of yesterday's open interest. */
    oi_share: round(oiShare, 3),
    /** The session so far against the same denominator. */
    day_vol_oi: round(dayVolume / oi, 2),
    last: price,
    bid: now.bid ?? null,
    ask: now.ask ?? null,
    side: inferSide(price, now.bid ?? null, now.ask ?? null, cfg.sideTolerance),
    iv: meta.iv ?? null,
    delta: meta.delta ?? null,
  };
}

/**
 * Every burst in this poll, loudest first.
 *
 * `quotes` is what the feed just returned, `prev` the previous poll keyed by
 * contract symbol, `meta` the watch set keyed the same way.
 */
function detectBursts(quotes, prev, meta, cfg = DEFAULT_BURST) {
  const out = [];
  for (const q of quotes) {
    const m = meta[q.symbol];
    if (!m) continue;
    const b = burstFor(q, prev[q.symbol], m, cfg);
    if (b) out.push(b);
  }
  // Dollars committed, not lot count: 400 lots of a $12 contract is a bigger
  // statement than 4,000 lots of a nickel.
  out.sort((a, b) => b.notional - a.notional);
  return out;
}

/** The compact per-contract state carried to the next poll. */
function snapshot(quotes) {
  const out = {};
  for (const q of quotes) {
    out[q.symbol] = { volume: q.volume || 0, last: q.last ?? null };
  }
  return out;
}

module.exports = { DEFAULT_BURST, inferSide, burstFor, detectBursts, snapshot };
