import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { computeGateScore } from "../lib/gate/compute.js";
import type { TradingMode } from "../lib/gate/types.js";

/**
 * GET /api/gate-score?mode=day|swing
 *
 * The "should I be trading today?" gate — ported from the standalone
 * ShouldIBeTrading app. Scores five categories, applies the hard overrides,
 * and returns a YES / CAUTION / NO plus a recommended posture.
 *
 * Route is prefixed `gate-` deliberately: the source app's routes were
 * `market-score`, `health`, `trades` and `calibration`, and the last three
 * collide with names already registered in this portal. A duplicate
 * registration fails SILENTLY in Azure Functions, so prefixing is not cosmetic.
 *
 * The scoring itself lives in lib/gate/compute.ts because the TradingView trend
 * webhook's regime refresh needs it too, and cannot reach this route over HTTP
 * (SWA gates /api/* behind the `portal` role).
 *
 * Deliberate differences from the source:
 *   - VIX/TNX/DXY come from Polygon first and Yahoo only as fallback, with a
 *     sanity guard on both. The original hit an unofficial Yahoo endpoint that
 *     failed *soft* to 0, which read as a spuriously bullish low-VIX market.
 *   - The trade journal is not wired up (starting empty by choice), so posture
 *     runs without the calibration step-down. The logic is intact for later.
 */

async function gateScore(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const mode: TradingMode = req.query.get("mode") === "day" ? "day" : "swing";
    const body = await computeGateScore(mode, (m) => ctx.warn(m));
    return { jsonBody: body, headers: { "Cache-Control": "no-store" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`gate-score error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("gateScore", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "gate-score",
  handler: gateScore,
});
