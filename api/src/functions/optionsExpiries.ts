import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { getChain, ChainNotFoundError, ChainParseError, ChainUnavailableError, optionsFeed } from "../lib/optionsChain.js";
import { dteBetween, DTE_MIN, DTE_MAX, DTE_IDEAL_MIN, DTE_IDEAL_MAX } from "../lib/spreadMath.js";
import { easternDateKey } from "../lib/dates.js";

/**
 * GET /api/options-expiries?ticker=X
 *
 * Step one of the Options Strategy Guide: which expiries this underlying lists,
 * how many days out each is, and which one the strategy wants.
 *
 * Portal-gated by the `/api/*` → ["portal"] catch-all in staticwebapp.config.json.
 * No config entry is needed; only machine-called routes require an anonymous one.
 */

/**
 * A monthly expiry is the third Friday. They carry materially more open interest
 * than weeklies, which is why `recommended` prefers them — a thin weekly can
 * technically satisfy the DTE window and still be a poor thing to trade.
 */
function isMonthly(iso: string): boolean {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.getUTCDay() !== 5) return false;
  const dom = d.getUTCDate();
  return dom >= 15 && dom <= 21;
}

/** Midpoint of the ideal window — what "closest to ideal" is measured against. */
const DTE_SWEET = Math.round((DTE_IDEAL_MIN + DTE_IDEAL_MAX) / 2);

async function optionsExpiriesHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const ticker = (req.query.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return { status: 400, jsonBody: { error: "ticker required" } };
  if (!/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return { status: 400, jsonBody: { error: "invalid_ticker", ticker } };
  }

  try {
    const chain = await getChain(ticker, null);
    // ET, not UTC: a UTC-derived DTE flips a day early every evening and would
    // silently shift expiries in and out of the 28-60 window after 5pm PT.
    const today = easternDateKey(new Date());

    const rows = chain.expiries
      .map((date) => {
        const dte = dteBetween(today, date);
        return dte === null ? null : {
          date, dte,
          monthly: isMonthly(date),
          inWindow: dte >= DTE_MIN && dte <= DTE_MAX,
          ideal: dte >= DTE_IDEAL_MIN && dte <= DTE_IDEAL_MAX,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.dte >= 0)
      .sort((a, b) => a.dte - b.dte);

    const inWindow = rows.filter((r) => r.inWindow);
    // Prefer a monthly inside the window, then any expiry in it, measured
    // against the middle of the ideal band.
    const pool = inWindow.filter((r) => r.monthly).length
      ? inWindow.filter((r) => r.monthly)
      : inWindow;
    const recommended = pool.length
      ? pool.reduce((best, cur) =>
          Math.abs(cur.dte - DTE_SWEET) < Math.abs(best.dte - DTE_SWEET) ? cur : best).date
      : null;

    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        ticker: chain.ticker,
        spot: chain.spot,
        as_of: chain.asOf,
        delayed: chain.delayed,
        feed: chain.feed,
        expirations: inWindow,
        // Everything else, so a symbol with nothing in 28-60 shows WHY rather
        // than an empty list the operator cannot interpret.
        outside_window: rows.filter((r) => !r.inWindow),
        recommended,
        dte_window: [DTE_MIN, DTE_MAX],
        dte_ideal: [DTE_IDEAL_MIN, DTE_IDEAL_MAX],
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

app.http("optionsExpiries", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "options-expiries",
  handler: optionsExpiriesHandler,
});
