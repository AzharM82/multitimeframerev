import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { fetchIntradaySnapshot, type IntradayQuote } from "../lib/polygon.js";

/**
 * GET /api/atr-intraday?tickers=AAA,BBB — live prices for the Top Setups view's
 * "buyable now" signal. Returns a {ticker: quote} map (live price + prior-day
 * high for the breakout trigger). The buyable signal is computed client-side
 * against each name's EOD SMA20/SMA50.
 */
async function atrIntradayHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const raw = (req.query.get("tickers") || "").trim();
  if (!raw) return { status: 400, jsonBody: { error: "tickers required" } };
  const tickers = raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, 250);

  try {
    const map = await fetchIntradaySnapshot(tickers);
    const quotes: Record<string, IntradayQuote> = {};
    for (const [t, q] of map) quotes[t] = q;
    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: { asOf: new Date().toISOString(), quotes },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("atrIntraday", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "atr-intraday",
  handler: atrIntradayHandler,
});
