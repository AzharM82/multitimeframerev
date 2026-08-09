import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { computeGateScore } from "../lib/gate/compute.js";
import { classifyRegime, writeRegime, type GateDecision } from "../lib/tvTrend/regime.js";

/**
 * POST /api/tv-regime-timer  (x-timer-secret)  — refresh the cached Gate regime
 *
 * Called by mtfrev-cron through the market day. Exists so the TradingView trend
 * webhook can qualify a streak against the day's regime with a single point
 * lookup — TradingView cancels at 3s, and computeGateScore() does live Polygon
 * and FinViz work that cannot fit in that budget.
 *
 * Mode is `day`: this system trades a 5-minute breadth streak, so the day
 * weighting (volatility + momentum heavy) is the right lens, not `swing`.
 */

async function tvRegimeTimer(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  try {
    const gate = await computeGateScore("day", (m) => ctx.warn(m));
    const label = gate.trend.spy.regime || "";
    const snap = {
      label,
      direction: classifyRegime(label),
      decision: gate.decision as GateDecision,
      qualityScore: gate.qualityScore,
      spyPrice: gate.trend.spy.price,
      ma50: gate.trend.spy.ma50,
      capturedAt: new Date().toISOString(),
    };
    await writeRegime(snap);
    ctx.log(`tv-regime: ${snap.label} (${snap.direction}) · Gate ${snap.decision} · quality ${snap.qualityScore}`);
    return { jsonBody: { status: "ok", ...snap } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`tv-regime-timer error: ${message}`);
    // Deliberately does NOT clear the stored row: a stale regime that the
    // webhook can age out beats no regime at all.
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("tvRegimeTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "tv-regime-timer",
  handler: tvRegimeTimer,
});
