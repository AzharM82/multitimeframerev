/**
 * Unusual options activity — the detection rules. Pure functions, no I/O.
 *
 * Ported from the standalone UnusualOptions scanner (detection.py) and rebuilt
 * around the one thing that scanner never had: real open interest.
 *
 * ── Why the rules changed ─────────────────────────────────────────────────
 * The original ran on Polygon daily bars because that plan carried no options
 * snapshot, so it had no open interest at all. Without OI the only anomaly it
 * could measure was "today's volume versus this contract's own 20-day average",
 * which it had to set at 100x to keep the noise out. Tradier gives volume and
 * prior-settlement open interest side by side in the chain call, so the real
 * test is back:
 *
 *     volume > 3 x open interest
 *
 * That says something the volume ratio cannot: more contracts changed hands
 * today than existed at yesterday's settlement, so this is new positioning
 * rather than the same contracts being passed around. It needs no history,
 * which is why the tab produces signals from its first run.
 *
 * The 20-day ratio is kept as a *secondary* filter. We accumulate our own
 * baseline one session at a time; until a contract has BASELINE_MIN_DAYS of
 * history its ratio is null and the gate is skipped rather than guessed at.
 *
 * ── The floor that matters ────────────────────────────────────────────────
 * Most option contracts trade roughly nothing on a given day. Both a raw
 * volume ratio and a raw vol/OI ratio explode on dead contracts, so the average
 * is floored and open interest below `oiFloor` is treated as unmeasurable
 * rather than as a very small denominator. Every quality problem this screen
 * has ever had traces back to skipping one of those two.
 */

"use strict";

/** Contracts need at least this many stored sessions before the ratio gate applies. */
const BASELINE_MIN_DAYS = 10;

/** Sessions of per-contract volume kept for the baseline. */
const BASELINE_WINDOW = 20;

const DEFAULT_THRESHOLDS = {
  dteMin: 25,
  dteMax: 35,
  /** Only contracts within this fraction of spot — far wings are illiquid noise. */
  moneynessPct: 0.25,
  contract: {
    /** The primary test: today's volume as a multiple of prior open interest. */
    volOiRatioMin: 3,
    /** Below this OI the ratio is not measurable, not "infinitely unusual". */
    oiFloor: 25,
    /** Dollars actually committed: volume x price x 100. */
    notionalPremiumMin: 100_000,
    minVolume: 500,
    /** Secondary, only once history exists. */
    volRatioMin: 100,
    avgVolumeFloor: 5,
  },
  baselineMinDays: BASELINE_MIN_DAYS,
  baselineWindow: BASELINE_WINDOW,
};

const log10 = (x) => (x > 0 ? Math.log10(x) : 0);
const round = (x, n) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(n)));

/** Calendar days between two YYYY-MM-DD dates. */
function dte(scanDate, expiry) {
  const a = Date.UTC(+scanDate.slice(0, 4), +scanDate.slice(5, 7) - 1, +scanDate.slice(8, 10));
  const b = Date.UTC(+expiry.slice(0, 4), +expiry.slice(5, 7) - 1, +expiry.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

function inDteWindow(scanDate, expiry, thr) {
  const d = dte(scanDate, expiry);
  return d >= thr.dteMin && d <= thr.dteMax;
}

/** Within `moneynessPct` of spot. Guards a missing spot by letting it through. */
function inMoneyness(strike, spot, thr) {
  if (!(spot > 0)) return true;
  return Math.abs(strike - spot) / spot <= thr.moneynessPct;
}

/**
 * All the numbers for one contract. Never throws on degenerate input — a scan
 * that dies on one malformed row reports nothing for the whole session.
 *
 * `obs.volumeHistory` is our own accumulated daily volume, oldest first, NOT
 * including today.
 */
function contractMetrics(obs, thr = DEFAULT_THRESHOLDS) {
  const c = thr.contract;
  const history = Array.isArray(obs.volumeHistory) ? obs.volumeHistory : [];
  const days = history.length;

  let avgRaw = null;
  let volRatio = null;
  if (days >= thr.baselineMinDays) {
    avgRaw = history.reduce((s, v) => s + v, 0) / days;
    const floored = Math.max(avgRaw, c.avgVolumeFloor);
    volRatio = floored > 0 ? obs.todayVolume / floored : 0;
  }

  // Below the floor the ratio is undefined, not enormous.
  const oi = obs.priorOi;
  const volOiRatio = oi !== null && oi !== undefined && oi >= c.oiFloor ? obs.todayVolume / oi : null;

  const notionalPremium = obs.todayVolume * obs.lastPrice * 100;

  // Rank. Notional and vol/OI are always present for a fired contract; the
  // volume ratio multiplies in only once there is history behind it, so a
  // contract is never penalised for being newly listed.
  const score = log10(notionalPremium) * (volOiRatio ?? 0) * (volRatio !== null ? Math.max(log10(volRatio), 0.1) : 1);

  return {
    avgVolume20d: round(avgRaw, 2),
    baselineDays: days,
    volRatio: round(volRatio, 2),
    volOiRatio: round(volOiRatio, 2),
    notionalPremium: round(notionalPremium, 2),
    anomalyScore: round(score, 2),
  };
}

/** Every gate, in the order that rejects most cheaply. */
function passes(obs, m, thr = DEFAULT_THRESHOLDS) {
  const c = thr.contract;
  if (obs.todayVolume < c.minVolume) return false;
  if (m.volOiRatio === null || m.volOiRatio < c.volOiRatioMin) return false;
  if (m.notionalPremium < c.notionalPremiumMin) return false;
  // Secondary: applies only where we have earned an opinion.
  if (m.volRatio !== null && m.volRatio < c.volRatioMin) return false;
  return true;
}

/** A signal, or null when the contract is ordinary. */
function evaluateContract(obs, scanDate, spot, thr = DEFAULT_THRESHOLDS) {
  if (!inDteWindow(scanDate, obs.expiry, thr)) return null;
  if (!inMoneyness(obs.strike, spot, thr)) return null;
  if (!(obs.lastPrice > 0)) return null;
  const m = contractMetrics(obs, thr);
  if (!passes(obs, m, thr)) return null;
  return {
    occSymbol: obs.occSymbol,
    underlying: obs.underlying,
    type: obs.type,
    strike: obs.strike,
    expiry: obs.expiry,
    dte: dte(scanDate, obs.expiry),
    spot: round(spot, 2),
    todayVolume: obs.todayVolume,
    priorOi: obs.priorOi,
    lastPrice: obs.lastPrice,
    bid: obs.bid ?? null,
    ask: obs.ask ?? null,
    iv: round(obs.iv ?? null, 4),
    delta: round(obs.delta ?? null, 4),
    volumeHistory: obs.volumeHistory ? obs.volumeHistory.slice(-thr.baselineWindow) : [],
    ...m,
  };
}

/**
 * Per-underlying totals across everything scanned, not just what fired.
 *
 * The put/call ratio is the point: one loud call sweep reads very differently
 * when the whole name is being bought than when it is the only green print in a
 * wall of puts. Computed on volume, which is what actually traded today.
 */
function aggregate(observations) {
  const by = new Map();
  for (const o of observations) {
    let a = by.get(o.underlying);
    if (!a) {
      a = { underlying: o.underlying, callVolume: 0, putVolume: 0, callOi: 0, putOi: 0, notional: 0 };
      by.set(o.underlying, a);
    }
    const notional = o.todayVolume * o.lastPrice * 100;
    if (o.type === "C") { a.callVolume += o.todayVolume; a.callOi += o.priorOi || 0; }
    else { a.putVolume += o.todayVolume; a.putOi += o.priorOi || 0; }
    a.notional += Number.isFinite(notional) ? notional : 0;
  }
  return [...by.values()]
    .map((a) => ({
      ...a,
      notional: round(a.notional, 2),
      // Undefined rather than Infinity when nothing traded on one side.
      putCallRatio: a.callVolume > 0 ? round(a.putVolume / a.callVolume, 3) : null,
      totalVolume: a.callVolume + a.putVolume,
    }))
    .sort((x, y) => y.notional - x.notional);
}

/**
 * Fold today's volumes into the stored baseline and drop contracts we have not
 * seen in a while, so the blob does not grow without bound as expiries roll off.
 */
function updateBaselines(previous, observations, thr = DEFAULT_THRESHOLDS) {
  const next = {};
  const seen = new Set();
  for (const o of observations) {
    seen.add(o.occSymbol);
    const prior = (previous && previous[o.occSymbol]) || [];
    next[o.occSymbol] = [...prior, o.todayVolume].slice(-thr.baselineWindow);
  }
  // Contracts absent today keep their history for a while — a quiet day is not
  // a delisting, and dropping them would reset the window on every gap.
  for (const [sym, hist] of Object.entries(previous || {})) {
    if (!seen.has(sym) && hist.length) next[sym] = hist.slice(-thr.baselineWindow);
  }
  return next;
}

module.exports = {
  DEFAULT_THRESHOLDS,
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW,
  dte,
  inDteWindow,
  inMoneyness,
  contractMetrics,
  passes,
  evaluateContract,
  aggregate,
  updateBaselines,
};
