import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { ALL_TICKERS } from "../lib/rotationUniverse.js";
import {
  cacheGet,
  cacheSet,
  computePerformance,
  easternToday,
  findTradingDay,
  firstOfMonth,
  mondayOf,
} from "../lib/rotation.js";

/**
 * GET /api/rot-performance?period=weekly|monthly
 *
 * Percent change from the open of the period's first trading day to the close
 * of the most recent trading day, per ticker.
 *
 * "Weekly" means week-to-date from Monday, and "monthly" month-to-date from the
 * 1st — not trailing 7/30 days. That is the original behaviour and it is what
 * makes the numbers agree with a Monday-anchored rotation view.
 */

const CACHE_TTL = 300; // seconds

async function rotPerformance(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const period = req.query.get("period") ?? "weekly";
    if (period !== "weekly" && period !== "monthly") {
      return { status: 400, jsonBody: { error: "period must be 'weekly' or 'monthly'" } };
    }

    const cacheKey = `rot:perf:${period}`;
    const cached = await cacheGet<object>(cacheKey);
    if (cached) {
      return { jsonBody: { ...cached, cached: true }, headers: { "Cache-Control": "no-store" } };
    }

    const today = easternToday();
    const startCandidate = period === "weekly" ? mondayOf(today) : firstOfMonth(today);

    // Forward from the period start (the 1st may be a weekend/holiday),
    // backward from today (today's bars may not exist yet).
    const start = await findTradingDay(startCandidate, "forward", 5);
    if (!start) {
      return {
        status: 503,
        jsonBody: { error: "no_start_day", message: `No trading day found near ${startCandidate}` },
      };
    }

    const end = await findTradingDay(today, "backward", 5);
    if (!end) {
      return { status: 503, jsonBody: { error: "no_end_day", message: "No recent trading day found" } };
    }

    const performance = computePerformance(start, end, new Set(ALL_TICKERS));

    const body = {
      performance,
      period,
      startDate: start.date,
      endDate: end.date,
      count: Object.keys(performance).length,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    await cacheSet(cacheKey, body, CACHE_TTL);
    return { jsonBody: body, headers: { "Cache-Control": "no-store" } };
  } catch (err) {
    // Transport failures surface here rather than being mistaken for holidays.
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`rot-performance error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("rotPerformance", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rot-performance",
  handler: rotPerformance,
});
