import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { getChain, ChainNotFoundError, ChainParseError, ChainUnavailableError, optionsFeed } from "../lib/optionsChain.js";
import { buildLadder } from "../lib/spreadLadder.js";
import { fetchVixData } from "../lib/gate/macroQuotes.js";
import {
  checkDte, checkVix, dteBetween,
  DTE_MIN, DTE_MAX, DELTA_MIN, DELTA_MAX, DELTA_TARGET,
  VIX_MIN, VIX_MAX, MIN_OPEN_INTEREST, WIDTH_BASIC, WIDTH_FULL, WIDTH_MAX,
} from "../lib/spreadMath.js";
import { easternDateKey } from "../lib/dates.js";

/**
 * GET /api/options-spread?ticker=X&expiration=YYYY-MM-DD
 *
 * Step two: one chain fetch, and every viable Floor Bet and Ceiling Bet for that
 * expiry, already costed — credit, max profit/loss, breakeven, probability and
 * the payoff vertices. The browser does no options arithmetic; see
 * lib/spreadLadder.ts for why the ladder is precomputed rather than the raw
 * chain being shipped.
 *
 * Portal-gated by the `/api/*` catch-all. No staticwebapp.config.json entry.
 */
async function optionsSpreadHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const ticker = (req.query.get("ticker") || "").trim().toUpperCase();
  const expiration = (req.query.get("expiration") || "").trim();

  if (!ticker) return { status: 400, jsonBody: { error: "ticker required" } };
  if (!/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return { status: 400, jsonBody: { error: "invalid_ticker", ticker } };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return { status: 400, jsonBody: { error: "expiration must be YYYY-MM-DD" } };
  }

  try {
    const chain = await getChain(ticker, expiration);

    // The feed can legitimately answer with a different expiry than requested
    // (an unlisted date, or its own default). Saying so beats rendering another
    // expiry's strikes under the date the operator typed.
    const served = chain.currentExpiry || expiration;
    const mismatch = served !== expiration;

    const ladder = buildLadder(chain);

    const today = easternDateKey(new Date());
    const dte = dteBetween(today, served);
    const dteCheck = checkDte(dte);

    // VIX is best-effort: the levels and the spread math are the point of this
    // endpoint, and a macro-quote outage must not 500 the whole tab.
    let vix: {
      level: number | null; source: string; degraded: boolean; warnings: string[];
    } = { level: null, source: "none", degraded: true, warnings: ["VIX not fetched"] };
    try {
      const v = await fetchVixData();
      vix = { level: v.level, source: v.source, degraded: v.degraded, warnings: v.warnings };
    } catch (e) {
      vix.warnings = [e instanceof Error ? e.message : "VIX fetch failed"];
    }
    // checkVix enforces the rule that a degraded or zero reading can never
    // pass — a dead quote once scored as a calm tape.
    const vixCheck = checkVix(vix.level, vix.degraded);

    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        ticker: chain.ticker,
        spot: chain.spot,
        as_of: chain.asOf,
        delayed: chain.delayed,
        feed: chain.feed,
        expiration: served,
        requested_expiration: expiration,
        expiration_mismatch: mismatch,
        dte,
        expiries: chain.expiries,
        ladder: {
          floor: ladder.floor,
          ceiling: ladder.ceiling,
        },
        recommended: ladder.recommended,
        greeks_available: ladder.greeksAvailable,
        strikes_without_greeks: ladder.strikesWithoutGreeks,
        checks: { dte: dteCheck, vix: vixCheck },
        vix,
        // Thresholds ride along so the UI never hardcodes a number that could
        // drift out of step with the server's rules.
        rules: {
          dte: [DTE_MIN, DTE_MAX],
          delta: [DELTA_MIN, DELTA_TARGET, DELTA_MAX],
          vix: [VIX_MIN, VIX_MAX],
          min_open_interest: MIN_OPEN_INTEREST,
          widths: [WIDTH_BASIC, WIDTH_FULL, WIDTH_MAX],
        },
      },
    };
  } catch (err) {
    if (err instanceof ChainNotFoundError) {
      return { status: 404, jsonBody: { error: "not_found", ticker: err.ticker, detail: err.message } };
    }
    if (err instanceof ChainUnavailableError) {
      return { status: 503, jsonBody: { error: err.code, detail: err.message, feed: optionsFeed() } };
    }
    if (err instanceof ChainParseError) {
      return {
        status: 502,
        jsonBody: {
          error: "chain_parse_failed",
          detail: err.message,
          feed: optionsFeed(),
          ticker,
        },
      };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("optionsSpread", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "options-spread",
  handler: optionsSpreadHandler,
});
