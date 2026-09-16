/**
 * Tradier option-chain provider — real-time OPRA, selected by OPTIONS_FEED=tradier.
 *
 * This is the feed the Options Guide was always meant to have. The FinViz
 * scrape it replaces is 15 minutes old and comes out of an HTML page; Alpaca's
 * real-time option data is behind a $99/month plan. A Tradier brokerage account
 * carries real-time Level 1 for options at no extra cost, with ORATS greeks,
 * implied volatility, open interest and volume on every contract, as JSON.
 *
 * Two calls per chain: the expiration list (so the tab can offer every expiry)
 * and the chain itself. The underlying's price comes from the same account's
 * real-time quote, so the spot and the contracts are on one clock — the thing
 * the Rotation tab had to be rescued from twice.
 *
 * Failure is loud and named, exactly as the other providers: an unknown symbol
 * is not a feed outage, and a shape we cannot read is not an empty chain.
 */

import type { OptionChain, OptionContract, OptionType } from "./optionsChain.js";
import { ChainNotFoundError, ChainParseError, ChainUnavailableError } from "./optionsChain.js";
import { TradierError, expirations, optionChain, quote, tradierConfigured } from "./tradier.js";

/** Real-time for every Tradier brokerage account holder — the whole point of the switch. */
const DELAYED = false;
const FEED = "tradier";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Nearest listed expiry at or after `wanted`, else the first one. */
function pickExpiry(expiries: string[], wanted: string | null): string {
  if (!expiries.length) return "";
  if (!wanted) return expiries[0];
  return expiries.find((e) => e >= wanted) ?? expiries[expiries.length - 1];
}

export async function fetchChain(ticker: string, expiry: string | null): Promise<OptionChain> {
  if (!tradierConfigured()) {
    throw new ChainUnavailableError(
      "tradier_not_configured",
      "OPTIONS_FEED=tradier is selected but TRADIER_TOKEN is not set. Set it in the app settings, " +
      "or set OPTIONS_FEED=finviz to fall back to the delayed feed.",
    );
  }

  let expiries: string[];
  let spotQuote;
  try {
    [expiries, spotQuote] = await Promise.all([expirations(ticker), quote(ticker)]);
  } catch (err) {
    if (err instanceof TradierError && (err.status === 401 || err.status === 403)) {
      throw new ChainUnavailableError("tradier_unauthorised", `Tradier rejected the token (HTTP ${err.status}). Check TRADIER_TOKEN.`);
    }
    const m = err instanceof Error ? err.message : String(err);
    throw new ChainUnavailableError("tradier_unreachable", `Tradier could not be reached: ${m}`);
  }

  if (!expiries.length) {
    throw new ChainNotFoundError(ticker, `Tradier lists no options for ${ticker}.`);
  }
  const currentExpiry = pickExpiry(expiries, expiry);

  let raw;
  try {
    raw = await optionChain(ticker, currentExpiry, true);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new ChainUnavailableError("tradier_unreachable", `Tradier could not be reached: ${m}`);
  }
  if (!raw.length) {
    throw new ChainParseError(`Tradier returned no contracts for ${ticker} ${currentExpiry}`);
  }

  const contracts: OptionContract[] = [];
  let newest = 0;
  for (const o of raw) {
    const strike = num(o.strike);
    const type = o.option_type === "put" || o.option_type === "call" ? (o.option_type as OptionType) : null;
    if (strike === null || type === null) continue;
    const g = o.greeks ?? null;
    contracts.push({
      strike,
      type,
      bid: num(o.bid),
      ask: num(o.ask),
      // Tradier signs delta the way the tab expects: puts negative, calls positive.
      delta: g ? num(g.delta) : null,
      iv: g ? num(g.mid_iv) ?? num(g.smv_vol) : null,
      openInterest: num(o.open_interest),
      volume: num(o.volume),
    });
    const t = num(o.trade_date);
    if (t !== null && t > newest) newest = t;
  }
  if (!contracts.length) {
    throw new ChainParseError(`chain carried ${raw.length} rows, none of which parsed`);
  }

  // The underlying's own real-time last; the chain's newest print is the fallback
  // for the timestamp so the tab can say how fresh the numbers actually are.
  const spot = num(spotQuote?.last) ?? num(spotQuote?.close) ?? num(spotQuote?.prevclose);
  if (spot === null) {
    throw new ChainParseError(`Tradier gave no price for ${ticker}`);
  }
  const stamp = num(spotQuote?.trade_date) ?? newest;

  return {
    ticker: ticker.toUpperCase(),
    spot,
    asOf: stamp ? new Date(stamp).toISOString() : new Date().toISOString(),
    delayed: DELAYED,
    feed: FEED,
    expiries,
    currentExpiry,
    contracts: contracts.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type)),
  };
}
