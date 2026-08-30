/**
 * Alpaca option-chain provider — WIRED BUT NOT ENABLED.
 *
 * Selected by OPTIONS_FEED=alpaca. It is not the default, and the reason is
 * cost rather than capability:
 *
 *   feed=indicative → 200, free on Basic, but it is DERIVED pricing, not OPRA,
 *                     and it carried greeks on only 157 of 400 contracts when
 *                     measured on AAPL (2026-08-29). A chain with a third of
 *                     its deltas missing cannot drive a 20–30 delta rule.
 *   feed=opra       → 403 {"message":"OPRA agreement is not signed"}. That is a
 *                     paywall, not a click-through: real-time OPRA needs Algo
 *                     Trader Plus at $99/mo.
 *
 * ALPACA_API_KEY / ALPACA_API_SECRET are ALREADY in the production app settings
 * (Opening Drive uses them for stock bars), so enabling this is a subscription
 * decision followed by a verification pass, not a build.
 *
 * Before switching OPTIONS_FEED=alpaca, confirm:
 *   1. feed=opra returns 200 rather than the agreement 403;
 *   2. greeks are present on materially all contracts, not ~40%;
 *   3. the strike/expiry filter params return a whole expiry in one page — the
 *      snapshots endpoint paginates and a 400-contract first page did not even
 *      reach the target expiry.
 *
 * Until then this fails loudly and namefully. It deliberately does NOT fall
 * back to the indicative feed: silently serving derived prices where the
 * operator asked for real-time would be exactly the kind of quiet substitution
 * this tab must never make.
 */

import type { OptionChain } from "./optionsChain.js";
import { ChainUnavailableError } from "./optionsChain.js";

export const ALPACA_DATA_BASE = "https://data.alpaca.markets";

/** Mirrors the credential resolution already used by api/src/lib/alpaca.ts. */
export function alpacaConfigured(): boolean {
  const key = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID || "";
  const secret = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY || "";
  return Boolean(key && secret);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function fetchChain(_ticker: string, _expiry: string | null): Promise<OptionChain> {
  throw new ChainUnavailableError(
    "alpaca_feed_not_enabled",
    alpacaConfigured()
      ? "OPTIONS_FEED=alpaca is selected, but the Alpaca options provider is not enabled. " +
        "Real-time OPRA requires an Algo Trader Plus subscription ($99/mo); the free indicative " +
        "feed is derived pricing with incomplete greeks and is deliberately not used as a fallback. " +
        "Set OPTIONS_FEED=finviz to use the working delayed feed."
      : "OPTIONS_FEED=alpaca is selected but ALPACA_API_KEY / ALPACA_API_SECRET are not set.",
  );
}
