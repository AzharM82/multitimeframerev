/**
 * FinViz option-chain provider — the ONLY file that knows FinViz serves this as
 * HTML rather than JSON.
 *
 *   https://elite.finviz.com/stock?t=AAPL&p=d&ty=oc&e=YYYY-MM-DD
 *
 * The page server-renders the whole expiry into a JSON blob, which is why this
 * beat every alternative: one request yields strikes, bid/ask, open interest,
 * IV and a COMPLETE set of greeks. Verified live 2026-08-29 on AAPL — 122
 * contracts for 2026-10-02, delta on every one.
 *
 * Contract shape as FinViz emits it:
 *   { ticker, exDate, strike, openInterest, averageVolume, bidPrice, askPrice,
 *     lastClose, lastChange, lastSize, lastVolume, lastTime, iv, ivPCP,
 *     delta, gamma, theta, vega, rho, lambda, type }
 * Enclosing object: { ticker, currentExpiry, expiries[], options[], lastClose,
 *                     lastTime, view }
 *
 * ── Things learned the hard way, recorded so they are not re-learned ──────
 * 1. `&auth=` DOES NOTHING here. Authed and unauthed responses were byte-for-byte
 *    identical (140292 B both). The export API's key does not apply to this page,
 *    so this is the public view and the data is 15-minute delayed — the page says
 *    so itself: "Futures and options delayed by 15 minutes." We still send the
 *    key, harmlessly, in case that ever changes.
 * 2. There is NO JSON endpoint. /api/v1/options, /api/v1/option-chain,
 *    /api/v1/options-export-csv and /quote_option_export.ashx all 404. Parsing
 *    the page is the only route.
 * 3. Because this is a scrape, every failure mode here is LOUD. A partially
 *    understood page throws rather than returning the contracts it managed to
 *    read: half a chain silently becomes a wrong recommendation, and this tab's
 *    output is a trade the operator is told to place.
 */

import type { OptionChain, OptionContract, OptionType } from "./optionsChain.js";
import { ChainNotFoundError, ChainParseError, ChainUnavailableError } from "./optionsChain.js";

const BASE = "https://elite.finviz.com";
const FEED = "finviz";

/** FinViz quotes options on a 15-minute delay; stated on the page itself. */
const DELAYED = true;

interface FinvizOption {
  strike?: unknown; type?: unknown;
  bidPrice?: unknown; askPrice?: unknown;
  delta?: unknown; iv?: unknown;
  openInterest?: unknown; averageVolume?: unknown; lastVolume?: unknown;
}

interface FinvizBlob {
  ticker?: unknown;
  currentExpiry?: unknown;
  expiries?: unknown;
  options?: unknown;
  lastClose?: unknown;
  lastTime?: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Pull the chain object out of the page.
 *
 * Anchors on `"expiries"` — a key unique to this blob — then walks BACKWARDS to
 * the opening brace of the object containing it and forward with a brace
 * counter to its close. Anchoring on a stable key and bracket-matching survives
 * markup churn around the payload far better than any regex over the whole page
 * would, and when it does fail it fails completely rather than half-matching.
 */
export function extractChainBlob(html: string): FinvizBlob {
  const anchor = html.indexOf('"expiries"');
  if (anchor < 0) {
    throw new ChainParseError('option chain payload not found (no "expiries" key)');
  }
  const start = html.lastIndexOf("{", anchor);
  if (start < 0) throw new ChainParseError("option chain payload has no opening brace");

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    // Brace counting must ignore braces inside strings, or a description field
    // containing one truncates the object and JSON.parse fails misleadingly.
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw) as FinvizBlob;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          throw new ChainParseError(`option chain payload is not valid JSON: ${m}`);
        }
      }
    }
  }
  throw new ChainParseError("option chain payload never closed");
}

function toContract(o: FinvizOption): OptionContract | null {
  const strike = num(o.strike);
  const t = String(o.type ?? "").toLowerCase();
  if (strike === null || (t !== "put" && t !== "call")) return null;
  return {
    strike,
    type: t as OptionType,
    // FinViz reports an absent quote as 0. That is genuinely "no bid" for an
    // illiquid strike, so it is preserved as 0 rather than nulled — the
    // liquidity check is what decides it cannot be traded, not the parser.
    bid: num(o.bidPrice),
    ask: num(o.askPrice),
    delta: num(o.delta),
    iv: num(o.iv),
    openInterest: num(o.openInterest),
    volume: num(o.lastVolume) ?? num(o.averageVolume),
  };
}

export async function fetchChain(ticker: string, expiry: string | null): Promise<OptionChain> {
  const key = (process.env.FINVIZ_API_KEY || "").trim();
  if (!key) {
    throw new ChainUnavailableError(
      "finviz_not_configured",
      "FINVIZ_API_KEY is not set — the option chain cannot be fetched.",
    );
  }

  const params = new URLSearchParams({ t: ticker, p: "d", ty: "oc" });
  if (expiry) params.set("e", expiry);
  params.set("auth", key);

  let res: Response;
  try {
    res = await fetch(`${BASE}/stock?${params.toString()}`, {
      headers: {
        // Sent because the page is a browser view; without a plausible UA some
        // FinViz paths serve a stripped response.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html",
      },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new ChainUnavailableError("finviz_unreachable", `FinViz could not be reached: ${m}`);
  }

  // A 404 from the quote page means the SYMBOL is unknown, not that FinViz is
  // unwell. Reporting it as a provider error sends the operator looking for an
  // outage when they mistyped a ticker.
  if (res.status === 404) {
    throw new ChainNotFoundError(ticker, `No such symbol on FinViz: ${ticker}`);
  }
  if (!res.ok) {
    throw new ChainUnavailableError("finviz_error", `FinViz returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const blob = extractChainBlob(html);

  const expiries = Array.isArray(blob.expiries)
    ? blob.expiries.map((e) => String(e)).filter(Boolean)
    : [];
  const rawOptions = Array.isArray(blob.options) ? (blob.options as FinvizOption[]) : [];
  const contracts = rawOptions
    .map(toContract)
    .filter((c): c is OptionContract => c !== null);

  // A page that parsed but yielded nothing tradeable is not a valid chain. This
  // is the difference between "AAPL has no options" (it does) and "the payload
  // shape moved" — the latter must be reported, not rendered as an empty tab.
  if (!expiries.length) {
    throw new ChainParseError("chain parsed but carried no expirations");
  }
  if (rawOptions.length && !contracts.length) {
    throw new ChainParseError(`chain carried ${rawOptions.length} rows, none of which parsed`);
  }

  const spot = num(blob.lastClose);
  if (spot === null) throw new ChainParseError("chain carried no underlying price");

  // `lastTime` is unix seconds on this payload.
  const t = num(blob.lastTime);
  const asOf = t !== null ? new Date(t * 1000).toISOString() : "";

  return {
    ticker: String(blob.ticker ?? ticker).toUpperCase(),
    spot,
    asOf,
    delayed: DELAYED,
    feed: FEED,
    expiries,
    currentExpiry: String(blob.currentExpiry ?? expiry ?? ""),
    contracts,
  };
}
