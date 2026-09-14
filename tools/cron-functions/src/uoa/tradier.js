/**
 * Tradier market data for the unusual-options sweep. READ ONLY.
 *
 * A deliberate second copy of the portal's client rather than a shared package:
 * this Function App deploys on its own, has no build step, and must not gain a
 * dependency on the API's TypeScript output. It exposes only the three market
 * data calls the sweep needs and cannot reach /v1/accounts at all.
 *
 * ── The rate limiter is the important part ────────────────────────────────
 * Tradier allows 120 market-data requests a minute per token, and that token is
 * shared with StockAgentHub's executor, which is placing real orders on a
 * one-minute timer. A sweep that saturates the budget would starve it. So this
 * paces itself well under the limit and backs off on a 429 rather than
 * retrying immediately.
 */

"use strict";

const BASE = "https://api.tradier.com";

/** Leaves clear headroom for the hub's executor on the shared token. */
const DEFAULT_INTERVAL_MS = 700;
const MAX_RETRIES = 3;

let intervalMs = DEFAULT_INTERVAL_MS;
let nextSlot = 0;

/**
 * Change the pacing for one job.
 *
 * The watch-set build runs before the open, when StockAgentHub's executor is
 * idle and the whole 120/min budget is ours; the intraday poll runs while that
 * executor is placing real orders and must stay out of its way. Same token,
 * different neighbours.
 */
function setPace(ms) {
  intervalMs = Math.max(200, ms || DEFAULT_INTERVAL_MS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + intervalMs;
  if (wait > 0) await sleep(wait);
}

function many(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

async function get(path, params) {
  const token = (process.env.TRADIER_TOKEN || "").trim();
  if (!token) throw new Error("TRADIER_TOKEN is not set on the cron Function App");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await throttle();
    try {
      const res = await fetch(`${BASE}${path}?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        // Give the whole sweep room, not just this call: the budget is per token.
        nextSlot = Date.now() + 5_000 * (attempt + 1);
        lastErr = new Error("Tradier 429 rate limited");
        continue;
      }
      if (!res.ok) throw new Error(`Tradier ${res.status} ${path}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Up to ~300 symbols per GET; beyond that the URL is rejected. See quotesPost. */
async function quotes(symbols) {
  if (!symbols.length) return [];
  const d = await get("/v1/markets/quotes", { symbols: symbols.join(","), greeks: "false" });
  return many(d.quotes && d.quotes.quote);
}

/**
 * The same quotes, sent as a form POST — which is what makes live polling
 * affordable at all.
 *
 * A GET with 600 option symbols comes back 414 (URI too long); the POST form
 * took 1,164 contracts in 258 ms in testing. So the whole intraday watch set
 * refreshes in a handful of requests rather than one per underlying, and a poll
 * costs a few calls a minute against a 120/min budget shared with the hub's
 * live executor.
 */
async function quotesPost(symbols) {
  if (!symbols.length) return [];
  const token = (process.env.TRADIER_TOKEN || "").trim();
  if (!token) throw new Error("TRADIER_TOKEN is not set on the cron Function App");

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await throttle();
    try {
      const res = await fetch(`${BASE}/v1/markets/quotes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ symbols: symbols.join(","), greeks: "false" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        nextSlot = Date.now() + 5_000 * (attempt + 1);
        lastErr = new Error("Tradier 429 rate limited");
        continue;
      }
      if (!res.ok) throw new Error(`Tradier ${res.status} POST /markets/quotes`);
      const d = await res.json();
      return many(d.quotes && d.quotes.quote);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function expirations(symbol) {
  const d = await get("/v1/markets/options/expirations", { symbol, includeAllRoots: "true" });
  return many(d.expirations && d.expirations.date);
}

/** One expiry's full chain, with greeks, open interest and volume per contract. */
async function optionChain(symbol, expiration) {
  const d = await get("/v1/markets/options/chains", { symbol, expiration, greeks: "true" });
  return many(d.options && d.options.option);
}

/** The exchange calendar for one month: which days were open, and which closed. */
async function calendar(month, year) {
  const d = await get("/v1/markets/calendar", { month: String(month), year: String(year) });
  const days = (d.calendar && d.calendar.days && d.calendar.days.day) || [];
  return many(days);
}

module.exports = { quotes, quotesPost, expirations, optionChain, calendar, setPace };
