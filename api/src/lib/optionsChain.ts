/**
 * Provider-neutral option chain for the Options Strategy Guide.
 *
 * Every caller talks to this file and nothing else. Which feed actually answers
 * is decided by OPTIONS_FEED, so switching to a real-time source later is an app
 * setting rather than a rewrite:
 *
 *   finviz  (default) — 15-min delayed, FULL greeks on every contract, whole
 *                       expiry in one request, uses the FINVIZ_API_KEY we
 *                       already have. See finvizOptions.ts.
 *   alpaca            — real-time OPRA, but that needs Algo Trader Plus at
 *                       $99/mo. Credentials are already in the production app
 *                       settings; the free "indicative" feed carried greeks on
 *                       only 157 of 400 contracts, which is why it is not the
 *                       default. See alpacaOptions.ts.
 *
 * ── Why delayed data is acceptable here ───────────────────────────────────
 * The strategy picks a strike ~7% out of the money 28–60 days forward. Fifteen
 * minutes does not move which strike sits at 25 delta. The moment a live price
 * genuinely matters is when the order is sent, and that happens at the broker —
 * which is exactly what the tab's action steps tell the operator to do.
 *
 * `delayed` and `feed` ride in every chain so the UI states which clock it is
 * on rather than assuming. A tab that shows a stale credit without saying so is
 * the same hazard as a fabricated one, only slower.
 */

import { cacheGet, cacheSet } from "./rotation.js";

export type OptionType = "put" | "call";

export interface OptionContract {
  strike: number;
  type: OptionType;
  bid: number | null;
  ask: number | null;
  /** Signed as the feed reports it: puts negative, calls positive. */
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface OptionChain {
  ticker: string;
  /** Underlying last price, as the same feed sees it. */
  spot: number;
  /** ISO timestamp the feed stamped on the data, or "" when it gave none. */
  asOf: string;
  delayed: boolean;
  feed: string;
  /** Every expiry the underlying lists, ascending YYYY-MM-DD. */
  expiries: string[];
  currentExpiry: string;
  contracts: OptionContract[];
}

/**
 * Thrown when a provider answered but the payload could not be understood.
 *
 * Deliberately distinct from a network or auth failure: it means the upstream
 * shape changed under us. The handler turns it into a named 502 telling the
 * operator the parser needs updating, because a scraper that degrades quietly
 * is far worse than one that stops.
 */
export class ChainParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainParseError";
  }
}

/**
 * The symbol does not exist, or has no listed options.
 *
 * Kept separate from ChainUnavailableError because the two need opposite
 * reactions: "you mistyped the ticker" is the operator's to fix in a second,
 * while "the feed is down" is not. Collapsing them told the operator the data
 * provider had failed when they had simply typed ZZZZQQ.
 */
export class ChainNotFoundError extends Error {
  readonly ticker: string;
  constructor(ticker: string, message: string) {
    super(message);
    this.name = "ChainNotFoundError";
    this.ticker = ticker;
  }
}

/** Provider is unconfigured or not entitled — actionable, not a bug. */
export class ChainUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChainUnavailableError";
    this.code = code;
  }
}

export function optionsFeed(): string {
  const f = (process.env.OPTIONS_FEED || "finviz").trim().toLowerCase();
  return f === "alpaca" ? "alpaca" : "finviz";
}

/**
 * Cache TTLs.
 *
 * The chain is the expensive call and the one thing that moves, so it gets a
 * short life; the expiry list barely changes within a session. The FEED is part
 * of the key: without it, flipping OPTIONS_FEED would serve one provider's
 * normalised shape out of the other provider's cache entry and the `delayed`
 * badge would lie.
 */
const CHAIN_TTL = 300;
const EXPIRY_TTL = 3600;

const chainKey = (feed: string, t: string, e: string) => `opt:chain:${feed}:${t}:${e}`;
const expiryKey = (feed: string, t: string) => `opt:exp:${feed}:${t}`;

type Provider = {
  fetchChain(ticker: string, expiry: string | null): Promise<OptionChain>;
};

async function provider(): Promise<Provider> {
  if (optionsFeed() === "alpaca") return await import("./alpacaOptions.js");
  return await import("./finvizOptions.js");
}

/**
 * The chain for one expiry. Pass expiry `null` to let the provider return its
 * own default (used to discover the expiry list cheaply, since both providers
 * ship the full list alongside whichever expiry they answer with).
 *
 * A cache miss is indistinguishable from the cache being down — `cacheGet`
 * degrades to null on any Redis error — so a null here only ever means "go and
 * fetch", never "this symbol has no data".
 */
export async function getChain(ticker: string, expiry: string | null): Promise<OptionChain> {
  const feed = optionsFeed();
  const sym = ticker.trim().toUpperCase();
  const key = chainKey(feed, sym, expiry || "_default");

  const cached = await cacheGet<OptionChain>(key);
  // Guard against a shape written by an older build: if the required fields are
  // not all present, treat it as a miss rather than serving a half-payload.
  if (cached && Array.isArray(cached.contracts) && typeof cached.spot === "number") {
    return cached;
  }

  const p = await provider();
  const chain = await p.fetchChain(sym, expiry);
  await cacheSet(key, chain, CHAIN_TTL);
  if (chain.expiries.length) {
    await cacheSet(expiryKey(feed, sym), chain.expiries, EXPIRY_TTL);
  }
  return chain;
}

/** Just the expiry list, reusing a cached chain when one is already warm. */
export async function getExpiries(ticker: string): Promise<{ expiries: string[]; spot: number; asOf: string; delayed: boolean; feed: string }> {
  const feed = optionsFeed();
  const sym = ticker.trim().toUpperCase();
  const chain = await getChain(sym, null);
  return {
    expiries: chain.expiries,
    spot: chain.spot,
    asOf: chain.asOf,
    delayed: chain.delayed,
    feed,
  };
}
