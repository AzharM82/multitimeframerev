/**
 * Deterministic option backtest for the SPY breadth-streak system.
 *
 * NO MODEL RUNS IN HERE. Every number the report quotes is computed by this
 * file from real Polygon 5-minute bars; the Claude CLI only ever INTERPRETS the
 * resulting table. A language model that is also allowed to do the arithmetic
 * will eventually produce a confident number nobody can reproduce, and this
 * whole exercise exists to decide where real money goes.
 *
 * Fills use the NEXT bar's OPEN, never the signal bar's close. The streak is
 * confirmed at a bar close, so the earliest price you could actually have paid
 * is the next bar's open. Filling at the close of the bar that generated the
 * signal is the classic backtest lie and it flatters every result.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toTvSymbol, tvOptionBars, tvAvailable } from "./tvbars.mjs";

const POLY = "https://api.polygon.io";
const ET = "America/New_York";

export const etHHMM = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", { timeZone: ET, hour12: false }).slice(0, 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MEASURED 2026-08-11: the OPTION aggregates endpoint allows ~5 requests per
 * minute on this plan — a 429 arrives on the 6th call one second in. Equity
 * aggregates are not throttled the same way. So option bars are paced, not
 * retried: hammering and backing off just burns the budget and produces a
 * half-filled sweep that silently looks like a complete one.
 */
const OPTION_CALL_SPACING_MS = 13_000;
let lastOptionCall = 0;

async function paceOptionCall() {
  const wait = OPTION_CALL_SPACING_MS - (Date.now() - lastOptionCall);
  if (wait > 0) await sleep(wait);
  lastOptionCall = Date.now();
}

/** Polygon with retry. `paced` marks the rate-limited option endpoints. */
async function poly(url, key, { paced = false } = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (paced) await paceOptionCall();
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}apiKey=${key}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) { await sleep(OPTION_CALL_SPACING_MS); continue; }
    /**
     * 403 on an option aggregate means the DATE is not entitled, not the
     * contract: this plan sells option history from T-1 back, never the current
     * session (verified 2026-08-11 — same-day 403s for every expiry while SPY
     * equity bars for the same day return fine). Surfaced as a typed error so
     * the caller can say "not available until tomorrow" instead of dying with a
     * raw HTTP code.
     */
    if (res.status === 403) {
      const err = new Error(`option data for this date is not on the plan (T-1 and older only)`);
      err.code = "NOT_ENTITLED";
      throw err;
    }
    // Transient upstream failures get the same treatment as a rate limit. A
    // single 502 used to abort the whole sweep, which for an unattended 6am job
    // means no report and no obvious reason why.
    if (res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`polygon ${res.status} for ${url.split("?")[0].slice(-60)}`);
    return res.json();
  }
  throw new Error(`polygon unavailable after ${tries} attempts (rate limit or 5xx)`);
}

/**
 * On-disk bar cache, keyed by contract+date.
 *
 * At 5 option calls a minute a sweep costs real time, and the SAME contracts are
 * needed every time a given day is re-analysed. Caching turns a re-run from
 * fifteen minutes into seconds, which is the difference between an agent you
 * iterate on and one you avoid running. Option bars for a past session never
 * change, so the cache can never go stale.
 */
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "cache");
const cachePath = (ticker, date) => path.join(CACHE_DIR, `${ticker.replace(/[:]/g, "_")}_${date}.json`);

function readCache(ticker, date) {
  try { return JSON.parse(fs.readFileSync(cachePath(ticker, date), "utf8")); } catch { return null; }
}
function writeCache(ticker, date, rows) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(ticker, date), JSON.stringify(rows));
  } catch { /* cache is an optimisation, never a requirement */ }
}

/** SPY 5-min bars for a session, keyed by ET HH:MM. limit high + sort=asc or
 *  the response truncates to pre-market and silently mis-prices everything. */
export async function spyBars(date, key) {
  const j = await poly(`${POLY}/v2/aggs/ticker/SPY/range/5/minute/${date}/${date}?limit=50000&sort=asc`, key);
  const map = new Map();
  for (const b of j.results ?? []) map.set(etHHMM(b.t), b);
  return map;
}

const chainCache = new Map();
export async function chain(date, expiry, type, key) {
  const k = `${expiry}|${type}`;
  if (chainCache.has(k)) return chainCache.get(k);
  const j = await poly(
    `${POLY}/v3/reference/options/contracts?underlying_ticker=SPY&contract_type=${type}` +
      `&expiration_date=${expiry}&limit=1000&as_of=${date}`, key, { paced: true });
  const rows = (j.results ?? []).sort((a, b) => a.strike_price - b.strike_price);
  chainCache.set(k, rows);
  return rows;
}

const barCache = new Map();
export let fetchStats = { cached: 0, tradingview: 0, polygon: 0 };
/** Which source priced each contract, so any number in the report is traceable. */
export const barSource = new Map();

/**
 * Which source to prefer: "polygon" (default), "tradingview", or "auto".
 *
 * DEFAULT IS POLYGON, by operator decision 2026-08-12. It is headless, needs no
 * desktop app, never touches the operator's chart, and is the only source for
 * EXPIRED contracts. The cost is real and should be stated plainly: Polygon
 * refuses the current session (403), so the report necessarily covers the
 * PREVIOUS day, and its ~5 requests/minute cap makes a cold sweep take 10-20
 * minutes.
 *
 * "tradingview" buys same-day at the price of a desktop dependency and a couple
 * of minutes of the operator's chart being driven. "auto" prefers TradingView
 * when it is running. Nothing is deleted — this is one line in research.env.
 */
const BAR_SOURCE = (process.env.BAR_SOURCE || "polygon").toLowerCase();

let tvChecked = false, tvUsable = false;
async function tvReady() {
  if (BAR_SOURCE === "polygon") return false;
  if (!tvChecked) { tvChecked = true; tvUsable = await tvAvailable(); }
  return tvUsable;
}

export const barSourceMode = BAR_SOURCE;

/**
 * 5-minute bars for one contract on one session, keyed by ET HH:MM.
 *
 * SOURCE ORDER: disk cache, then TradingView, then Polygon.
 *
 * TradingView first because it is the only one that has TODAY — Polygon 403s the
 * current session on this plan — and because it answers in ~1.5s against
 * Polygon's enforced 13s spacing. Polygon is not redundant though: TradingView
 * does not serve EXPIRED contracts, and a backtest is mostly expired contracts.
 * So the two genuinely cover different halves of the problem and the fallback
 * stays.
 */
export async function optionBars(ticker, date, key, onFetch) {
  if (barCache.has(ticker)) return barCache.get(ticker);

  let rows = readCache(ticker, date);
  let source = "cache";

  if (rows) {
    fetchStats.cached += 1;
  } else {
    if (onFetch) onFetch(ticker);

    if (await tvReady()) {
      const sym = toTvSymbol(ticker);
      const tvBars = sym ? await tvOptionBars(sym) : null;
      if (tvBars && tvBars.length) {
        // TradingView hands back its whole window (~5 sessions); keep this day.
        rows = tvBars.filter((b) => new Date(b.t).toLocaleDateString("en-CA", { timeZone: ET }) === date);
        if (rows.length) { source = "tradingview"; fetchStats.tradingview += 1; }
        else rows = null; // in its window but not this date — let Polygon try
      }
    }

    if (!rows) {
      const j = await poly(`${POLY}/v2/aggs/ticker/${ticker}/range/5/minute/${date}/${date}?limit=50000&sort=asc`, key, { paced: true });
      rows = j.results ?? [];
      source = "polygon";
      fetchStats.polygon += 1;
    }
    writeCache(ticker, date, rows);
  }

  barSource.set(ticker, source);
  const map = new Map();
  for (const b of rows) map.set(etHHMM(b.t), b);
  barCache.set(ticker, map);
  return map;
}

/** Trading days ahead, skipping weekends. Holidays are not modelled — an expiry
 *  that lands on one simply has no contracts and the variant reports as unpriced
 *  rather than guessing. */
export function expiryOnOrAfter(date, daysAhead) {
  const d = new Date(`${date}T12:00:00Z`);
  let added = 0;
  while (added < daysAhead) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d.toISOString().slice(0, 10);
}

const MAX_FILL_SLIP_MIN = 10;

/**
 * The bar strictly AFTER a signal — where a realistic fill happens.
 *
 * Bounded on purpose. This used to return the next bar that existed at ANY
 * distance, so an illiquid contract with no print for two hours reported a
 * two-hour-late fill as though it were the next bar. That is not a fill, it is
 * a fiction, and it flatters exactly the thin contracts a sweep is meant to
 * expose. Beyond MAX_FILL_SLIP_MIN the leg is unpriceable and says so.
 */
function nextBarAfter(bars, hhmm) {
  const times = [...bars.keys()].sort();
  const t = times.find((x) => x > hhmm);
  if (!t) return null;
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const slip = mins(t) - mins(hhmm);
  if (slip > MAX_FILL_SLIP_MIN) return { at: t, bar: bars.get(t), slip, tooLate: true };
  return { at: t, bar: bars.get(t), slip };
}

/**
 * The bar an event belongs to, as ET HH:MM — the key every bar map is indexed by.
 *
 * The BAR's own clock, not arrival. They agree to within seconds on a healthy
 * feed, but a retry or a backfill arrives late, and filling a trade at the
 * arrival time of a replayed alert prices a bar the signal never saw.
 */
const eventAt = (e) =>
  (/^\d{2}:\d{2}$/.test(e.barHhmm ?? "") ? e.barHhmm : etHHMM(Date.parse(e.receivedAt)));

const sideOf = (e) =>
  e.side === "CALL" ? "call" : e.side === "PUT" ? "put"
    : String(e.signal ?? "").includes("CALL") ? "call"
    : String(e.signal ?? "").includes("PUT") ? "put" : null;

/**
 * Turn the day's conviction alerts into entry/exit pairs under one RULE SET.
 *
 * The indicator now decides — so unlike the streak system there is no regime to
 * filter on and no rules to reimplement. What is left worth arguing with is
 * WHEN to act on what it says: enter at the ARM or wait for the BUY, exit at the
 * first REDUCE or hold for the SELL, gate on how strong the score was.
 *
 * Kept out of the API on purpose, as before: a rule variant must be testable
 * without touching the code that alerts.
 */
export function pairConvictionTrades(events, rules) {
  const trades = [];
  let open = null; // { side, entryAt, entryScore }

  const close = (at, why) => { trades.push({ ...open, exitAt: at, exitWhy: why }); open = null; };

  for (const e of events) {
    const at = eventAt(e);
    const side = sideOf(e);
    const signal = String(e.signal ?? "");
    const score = Number(e.score ?? 0);

    const isEntry = rules.entry === "arm"
      ? signal === "ARM_CALL" || signal === "ARM_PUT"
      : signal === "BUY_CALL" || signal === "BUY_PUT";

    if (isEntry && side) {
      // An entry while something is open is a side flip the machine should not
      // have produced. Close the old one rather than silently dropping either.
      if (open && open.side !== side) close(at, "opposite signal");
      if (open) continue;
      if (rules.minScore && Math.abs(score) < rules.minScore) continue;
      open = { side, entryAt: at, entryScore: score, entrySignal: signal };
      continue;
    }

    if (!open) continue;

    // An ARM_CANCEL kills a position entered on the ARM; there is nothing else
    // that would ever close it, since no BUY followed.
    if (signal === "ARM_CANCEL" && rules.entry === "arm") { close(at, "arm cancelled"); continue; }

    if (side && side !== open.side) continue;

    if (rules.exit === "reduce" && (signal === "REDUCE_CALL" || signal === "REDUCE_PUT")) {
      close(at, "first reduce"); continue;
    }
    if (rules.exit !== "hold" && (signal === "SELL_CALL" || signal === "SELL_PUT")) {
      close(at, "sell signal"); continue;
    }
    if (rules.exitBelowScore && Math.abs(score) < rules.exitBelowScore) {
      close(at, `score faded below ${rules.exitBelowScore}`); continue;
    }
    // STAND_ASIDE means the indicator believes it is flat. Following it is the
    // same call the live state machine makes, and for the same reason.
    if (signal === "STAND_ASIDE" && rules.exit !== "hold") { close(at, "stand aside"); continue; }
  }

  if (open) trades.push({ ...open, exitAt: null, exitWhy: "still open at close" });
  return trades;
}

/** Price one trade against a real contract. Returns null when unpriceable — a
 *  missing bar is reported, never interpolated. */
export async function priceTrade(trade, opts, ctx) {
  const { date, key, spy } = ctx;
  const spot = spy.get(trade.entryAt)?.c;
  if (!spot) return { ...trade, skipped: "no SPY bar at entry" };

  const expiry = expiryOnOrAfter(date, opts.expiryDays);
  const rows = await chain(date, expiry, trade.side, key);
  if (!rows.length) return { ...trade, skipped: `no ${trade.side} chain for ${expiry}` };

  /**
   * otmSteps >= 0 : N strikes beyond spot on the OTM side (0 = first one out).
   * otmSteps <  0 : at the money, i.e. the strike nearest spot.
   *
   * NO FALLBACK. An earlier version defaulted to the last available strike when
   * the index ran off the end, which quietly priced an "ATM" variant against a
   * $950 call — a contract nobody would ever buy, reported as if it were the
   * result. Out of range is now unpriceable and says so.
   */
  const strikes = rows.map((r) => r.strike_price);
  let chosen;
  if (opts.otmSteps < 0) {
    chosen = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  } else {
    const otm = trade.side === "call"
      ? strikes.filter((s) => s > spot)
      : strikes.filter((s) => s < spot).reverse();
    chosen = otm[opts.otmSteps];
  }
  if (chosen === undefined) return { ...trade, skipped: `no strike at otmSteps=${opts.otmSteps}` };
  const contract = rows.find((r) => r.strike_price === chosen);

  const bars = await optionBars(contract.ticker, date, key, ctx.onFetch);
  const entry = nextBarAfter(bars, trade.entryAt);
  if (!entry) return { ...trade, contract: contract.ticker, skipped: "no option bar after entry" };
  if (entry.tooLate) {
    return { ...trade, contract: contract.ticker, skipped: `entry fill ${entry.slip}m late (illiquid contract)` };
  }

  /**
   * A position with no exit signal is FORCE-CLOSED on the last regular-hours bar
   * and counted, tagged `eodForced`.
   *
   * It used to be excluded as "unrealised", which quietly made the exit rules
   * incomparable: exit-on-streak-end always resolves, while hold-until-the-
   * opposite-streak leaves the day's last entry open — so `live` was scored on 3
   * trades and `exit-on-end` on 4, and the missing one was always the one still
   * running. Dropping it is not neutral; it removes whichever trade the rule was
   * still holding, which is precisely the behaviour under test.
   */
  let exit, exitWhy = trade.exitWhy, eodForced = false;
  if (trade.exitAt) exit = nextBarAfter(bars, trade.exitAt);
  if (!exit) {
    const rth = [...bars.keys()].filter((t) => t >= "09:30" && t < "16:00").sort();
    const last = rth[rth.length - 1];
    exit = last ? { at: last, bar: bars.get(last) } : null;
    exitWhy = trade.exitAt ? "no bar after exit — forced to last RTH bar" : "forced close at session end";
    eodForced = true;
  }
  if (!exit) return { ...trade, contract: contract.ticker, skipped: "no option bars in regular hours" };
  if (exit.tooLate) {
    return { ...trade, contract: contract.ticker, skipped: `exit fill ${exit.slip}m late (illiquid contract)` };
  }

  /**
   * Entry and a signalled exit fill at the NEXT bar's open — that is the first
   * price available after a signal confirms on a bar close.
   *
   * A FORCED close is different: there is no signal, we are simply flat at the
   * bell, so it fills at the last bar's CLOSE. Using that bar's open would throw
   * away its five minutes and quietly bias every hold-through variant.
   */
  const entryPx = entry.bar.o;
  const exitPx = eodForced ? exit.bar.c : exit.bar.o;
  const pnl = Math.round((exitPx - entryPx) * 100 * 100) / 100;
  return {
    ...trade,
    contract: contract.ticker, strike: chosen, expiry, spotAtEntry: spot,
    entryFillAt: entry.at, exitFillAt: exit.at,
    entryPx, exitPx, pnlPerContract: pnl,
    pctMove: Math.round(((exitPx - entryPx) / entryPx) * 10000) / 100,
    entrySlipMin: entry.slip ?? null, exitSlipMin: exit.slip ?? null,
    exitWhy, eodForced,
  };
}

/** Every priced trade counts, including the force-closed one — see priceTrade. */
export function summarise(trades) {
  const priced = trades.filter((t) => t.pnlPerContract !== undefined);
  const sum = (a) => a.reduce((s, t) => s + t.pnlPerContract, 0);
  const wins = priced.filter((t) => t.pnlPerContract > 0);
  return {
    signals: trades.length,
    priced: priced.length,
    skipped: trades.length - priced.length,
    realisedTrades: priced.length,
    eodForced: priced.filter((t) => t.eodForced).length,
    netPerContract: Math.round(sum(priced) * 100) / 100,
    winRate: priced.length ? Math.round((wins.length / priced.length) * 100) : null,
    avgPct: priced.length ? Math.round((priced.reduce((s, t) => s + t.pctMove, 0) / priced.length) * 100) / 100 : null,
    best: priced.length ? Math.max(...priced.map((t) => t.pnlPerContract)) : null,
    worst: priced.length ? Math.min(...priced.map((t) => t.pnlPerContract)) : null,
  };
}
