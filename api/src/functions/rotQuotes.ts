import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { ALL_TICKERS, STOCKS } from "../lib/rotationUniverse.js";
import { cacheGet, cacheSet, fetchQuotes, type Quote } from "../lib/rotation.js";
import { fetchQuotesFinviz } from "../lib/rotationFinviz.js";

/**
 * GET /api/rot-quotes
 *
 * Live snapshot quotes for the whole rotation universe (878 symbols), plus the
 * sector/industry classification so a client can build the Market → Sector →
 * Industry → Stock hierarchy without a second request.
 *
 * Query:
 *   ?meta=0   omit the classification block (quotes only, smaller payload)
 *   ?src=polygon  force the delayed Polygon path (comparison / debugging)
 *
 * The classification is served here rather than bundled into the frontend so
 * that the UI can be rebuilt freely without duplicating the universe — the
 * original app shipped the same 878 rows in BOTH its Python API and its React
 * bundle, which could drift.
 *
 * SOURCE ORDER: FinViz Elite (real-time) first, Polygon (~15 min delayed) as a
 * fallback. The fallback is not decoration — it covers an unset FINVIZ_API_KEY
 * and a FinViz outage or 429 storm, either of which would otherwise blank the
 * tab. `source` rides in the payload so the UI can label which clock the
 * numbers are on instead of asserting a freshness it cannot verify.
 */

const CACHE_KEY = "rot:quotes:all";
const CACHE_TTL = 30; // seconds — matches the original

interface QuotesResponse {
  quotes: Record<string, Quote>;
  count: number;
  timestamp: string;
  cached: boolean;
  /** Which feed served these numbers — drives the UI's freshness label. */
  source: "finviz" | "polygon";
  /** Universe size, so the UI can show real coverage (e.g. 864/878). */
  universe: number;
  /** Universe names the active source had no row for. */
  missing?: string[];
  stocks?: typeof STOCKS;
}

async function rotQuotes(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const includeMeta = req.query.get("meta") !== "0";
    const forcePolygon = req.query.get("src") === "polygon";

    const cached = forcePolygon ? null : await cacheGet<QuotesResponse>(CACHE_KEY);
    // A cache entry written by the pre-FinViz build has no `source`, and the UI
    // reads that field to label freshness — serving one would mislabel live
    // numbers as delayed. Treat it as a miss and refetch instead.
    if (cached?.source) {
      return {
        jsonBody: { ...cached, cached: true, ...(includeMeta ? { stocks: STOCKS } : {}) },
        headers: { "Cache-Control": "no-store" },
      };
    }

    let body: QuotesResponse | null = null;

    if (!forcePolygon) {
      // A FinViz failure must not take the tab down with it — fall through to
      // the delayed feed instead of surfacing a 500.
      try {
        const live = await fetchQuotesFinviz(ALL_TICKERS);
        if (live && live.covered > 0) {
          body = {
            quotes: live.quotes,
            count: live.covered,
            timestamp: new Date().toISOString(),
            cached: false,
            source: "finviz",
            universe: ALL_TICKERS.length,
            missing: live.missing,
          };
          if (live.missing.length > 0) {
            ctx.log(
              `rot-quotes: finviz covered ${live.covered}/${ALL_TICKERS.length}; ` +
                `no row for ${live.missing.join(", ")}`,
            );
          }
        } else {
          ctx.warn("rot-quotes: FinViz unavailable or empty — falling back to delayed Polygon");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.warn(`rot-quotes: FinViz failed (${message}) — falling back to delayed Polygon`);
      }
    }

    if (!body) {
      const quotes = await fetchQuotes(ALL_TICKERS);
      body = {
        quotes,
        count: Object.keys(quotes).length,
        timestamp: new Date().toISOString(),
        cached: false,
        source: "polygon",
        universe: ALL_TICKERS.length,
      };
      if (Object.keys(quotes).length === 0) {
        ctx.warn("rot-quotes: Polygon returned no quotes for any batch");
      }
    }

    // Cache without the (static, large) classification block. The forced-Polygon
    // debug path deliberately does NOT write: it exists to compare feeds, and
    // caching its delayed numbers would serve them to everyone else for 30s.
    if (!forcePolygon) await cacheSet(CACHE_KEY, body, CACHE_TTL);

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
