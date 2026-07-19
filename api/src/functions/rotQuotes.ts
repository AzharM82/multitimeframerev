import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { ALL_TICKERS, STOCKS } from "../lib/rotationUniverse.js";
import { cacheGet, cacheSet, fetchQuotes, type Quote } from "../lib/rotation.js";

/**
 * GET /api/rot-quotes
 *
 * Live snapshot quotes for the whole rotation universe (878 symbols), plus the
 * sector/industry classification so a client can build the Market → Sector →
 * Industry → Stock hierarchy without a second request.
 *
 * Query:
 *   ?meta=0   omit the classification block (quotes only, smaller payload)
 *
 * The classification is served here rather than bundled into the frontend so
 * that the UI can be rebuilt freely without duplicating the universe — the
 * original app shipped the same 878 rows in BOTH its Python API and its React
 * bundle, which could drift.
 */

const CACHE_KEY = "rot:quotes:all";
const CACHE_TTL = 30; // seconds — matches the original

interface QuotesResponse {
  quotes: Record<string, Quote>;
  count: number;
  timestamp: string;
  cached: boolean;
  stocks?: typeof STOCKS;
}

async function rotQuotes(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const includeMeta = req.query.get("meta") !== "0";

    const cached = await cacheGet<QuotesResponse>(CACHE_KEY);
    if (cached) {
      return {
        jsonBody: { ...cached, cached: true, ...(includeMeta ? { stocks: STOCKS } : {}) },
        headers: { "Cache-Control": "no-store" },
      };
    }

    const quotes = await fetchQuotes(ALL_TICKERS);
    const body: QuotesResponse = {
      quotes,
      count: Object.keys(quotes).length,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    // Cache without the (static, large) classification block.
    await cacheSet(CACHE_KEY, body, CACHE_TTL);

    if (Object.keys(quotes).length === 0) {
      ctx.warn("rot-quotes: Polygon returned no quotes for any batch");
    }

    return {
      jsonBody: includeMeta ? { ...body, stocks: STOCKS } : body,
      headers: { "Cache-Control": "no-store" },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`rot-quotes error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("rotQuotes", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rot-quotes",
  handler: rotQuotes,
});
