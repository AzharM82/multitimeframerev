import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, TABLES } from "../lib/tables.js";
import { historyPartition } from "./tvAnalysis.js";

/**
 * GET /api/tv-history?ticker=NIFTY[&date=YYYY-MM-DD]
 *
 * The day's net-score trend for one ticker, one point per 10-minute bar, in
 * chronological order. Feeds the histogram under the bullish/bearish cards.
 *
 * Points only exist for bars where the sidecar was actually watching this
 * ticker - it watches one at a time, so switching tickers pauses the previous
 * one's history rather than backfilling it. Gaps are real and are not
 * interpolated.
 */

interface HistoryRow {
  rowKey: string;
  ticker?: string;
  symbol?: string;
  net?: number;
  bullScore?: number;
  bearScore?: number;
  verdict?: string;
  price?: number | null;
  computedAt?: string;
}

async function tvHistoryHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const ticker = (req.query.get("ticker") || "").toUpperCase().trim();
  if (!ticker) return { status: 400, jsonBody: { error: "ticker required" } };

  const dateParam = req.query.get("date");
  const when = dateParam ? new Date(`${dateParam}T00:00:00Z`) : new Date();
  if (Number.isNaN(when.getTime())) {
    return { status: 400, jsonBody: { error: "date must be YYYY-MM-DD" } };
  }

  try {
    const rows = await listByPartition<HistoryRow>(
      TABLES.TV_ANALYSIS,
      historyPartition(ticker, when),
    );

    // Row keys are zero-padded epoch ms, so lexical sort is chronological.
    const points = rows
      .sort((a, b) => a.rowKey.localeCompare(b.rowKey))
      .map((r) => ({
        at: r.computedAt ?? new Date(Number(r.rowKey)).toISOString(),
        bucket: Number(r.rowKey),
        net: r.net ?? 0,
        bullScore: r.bullScore ?? 0,
        bearScore: r.bearScore ?? 0,
        verdict: r.verdict ?? "",
        price: r.price ?? null,
      }));

    return {
      jsonBody: {
        ticker,
        date: when.toISOString().slice(0, 10),
        count: points.length,
        points,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("tvHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "tv-history",
  handler: tvHistoryHandler,
});
