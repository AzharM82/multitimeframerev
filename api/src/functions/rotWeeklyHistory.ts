import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { ALL_TICKERS } from "../lib/rotationUniverse.js";
import {
  addDays,
  cacheGet,
  cacheSet,
  computePerformance,
  easternToday,
  findTradingDay,
  mondayOf,
} from "../lib/rotation.js";

/**
 * GET /api/rot-weekly-history?weeks=4
 *
 * Per-ticker performance for each of the last N calendar weeks (Monday open →
 * Friday close). Week 0 is the current, possibly partial, week.
 *
 * This is the heaviest endpoint in the tab: each week needs two grouped-daily
 * calls (~10k rows each) and each may walk up to 5 days to find a trading day.
 * Two things keep it sane:
 *   - `fetchGroupedDaily` memoises per date, so weeks sharing boundary days
 *     (holidays, short weeks) fetch each date at most once. The original
 *     re-fetched overlapping days and could issue ~40 requests.
 *   - Results are cached for 10 minutes; completed weeks never change.
 *
 * A week that cannot be resolved is returned with `performance: null` rather
 * than an empty object, so the client can distinguish "no data" from "flat".
 * The original returned 0 for missing weeks, which rendered as "0.0%" and read
 * as real flat performance.
 */

const CACHE_TTL = 600; // seconds
const MAX_WEEKS = 12;

interface WeekResult {
  label: string;
  weekIndex: number;
  startDate: string | null;
  endDate: string | null;
  performance: Record<string, number> | null;
}

async function rotWeeklyHistory(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const weeksParam = Number(req.query.get("weeks") ?? "4");
    const weeks = Number.isFinite(weeksParam)
      ? Math.min(Math.max(Math.trunc(weeksParam), 1), MAX_WEEKS)
      : 4;

    const cacheKey = `rot:weekly-history:${weeks}`;
    const cached = await cacheGet<object>(cacheKey);
    if (cached) {
      return { jsonBody: { ...cached, cached: true }, headers: { "Cache-Control": "no-store" } };
    }

    const today = easternToday();
    const universe = new Set(ALL_TICKERS);
    const results: WeekResult[] = [];

    for (let i = 0; i < weeks; i += 1) {
      const monday = addDays(mondayOf(today), -7 * i);
      const friday = addDays(monday, 4);
      const label = i === 0 ? "This Week" : i === 1 ? "1W Ago" : `${i}W Ago`;

      try {
        const start = await findTradingDay(monday, "forward", 5);
        // For the current week Friday may not have happened yet, so walk back
        // from the earlier of Friday and today.
        const endAnchor = friday > today ? today : friday;
        const end = start ? await findTradingDay(endAnchor, "backward", 5) : null;

        if (!start || !end || end.date < start.date) {
          results.push({ label, weekIndex: i, startDate: null, endDate: null, performance: null });
          continue;
        }

        results.push({
          label,
          weekIndex: i,
          startDate: start.date,
          endDate: end.date,
          performance: computePerformance(start, end, universe),
        });
      } catch (err) {
        // One failed week must not sink the whole response.
        ctx.warn(`rot-weekly-history: week ${i} failed: ${err instanceof Error ? err.message : err}`);
        results.push({ label, weekIndex: i, startDate: null, endDate: null, performance: null });
      }
    }

    const body = {
      weeks: results,
      resolved: results.filter((w) => w.performance !== null).length,
      requested: weeks,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    await cacheSet(cacheKey, body, CACHE_TTL);
    return { jsonBody: body, headers: { "Cache-Control": "no-store" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`rot-weekly-history error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("rotWeeklyHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rot-weekly-history",
  handler: rotWeeklyHistory,
});
