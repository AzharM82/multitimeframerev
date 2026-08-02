import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { replay } from "../lib/openingDrive/replay.js";
import { loadConfig } from "../lib/openingDrive/config.js";

/**
 * GET /api/opening-drive-replay?date=YYYY-MM-DD&tickers=RKLB,ARM  (x-timer-secret)
 *
 * Reconstructs a past session from Polygon historical bars and runs the full
 * gate → trigger → post-trigger logic. This is the validation surface for the
 * strategy's thresholds and the three acceptance tests; it touches no live
 * infrastructure. Secret-guarded because it is an operator/backtest tool, not a
 * portal-facing read.
 */

async function openingDriveReplayHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const date = (req.query.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { status: 400, jsonBody: { error: "date=YYYY-MM-DD required" } };
  }

  const tickers = (req.query.get("tickers") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tickers.length) {
    return { status: 400, jsonBody: { error: "tickers=A,B,C required" } };
  }

  try {
    const outcomes = await replay(date, tickers, loadConfig());
    return {
      jsonBody: {
        date,
        count: outcomes.length,
        gated: outcomes.filter((o) => o.gated).length,
        triggered: outcomes.filter((o) => o.triggered).length,
        outcomes,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("openingDriveReplay", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "opening-drive-replay",
  handler: openingDriveReplayHandler,
});
