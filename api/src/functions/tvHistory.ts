import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, upsert, TABLES } from "../lib/tables.js";
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

const BUCKET_MS = 10 * 60 * 1000;

interface BackfillPoint {
  at?: string;
  net?: number;
  bullScore?: number;
  bearScore?: number;
  verdict?: string;
  price?: number | null;
}

/**
 * POST /api/tv-history  (x-timer-secret)
 *
 * Bulk backfill from the sidecar, recomputed from the chart's own bar history.
 * Points are bucketed and upserted, so replaying a backfill is idempotent and
 * a later live reading for the same bar simply overwrites it.
 */
async function backfillHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: { ticker?: string; symbol?: string; points?: BackfillPoint[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const ticker = (body.ticker || "").toUpperCase().trim();
  const points = Array.isArray(body.points) ? body.points : [];
  if (!ticker) return { status: 400, jsonBody: { error: "ticker required" } };
  if (!points.length) return { jsonBody: { status: "ok", written: 0 } };
  if (points.length > 500) {
    return { status: 413, jsonBody: { error: "too many points (max 500)" } };
  }

  let written = 0;
  // Chunked rather than one-at-a-time: a full session is ~96 points and serial
  // upserts would take long enough for the portal to poll several times mid-write.
  const CHUNK = 20;
  for (let i = 0; i < points.length; i += CHUNK) {
    const slice = points.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (p) => {
        if (!p.at || typeof p.net !== "number") return;
        const when = new Date(p.at);
        if (Number.isNaN(when.getTime())) return;
        const bucket = Math.floor(when.getTime() / BUCKET_MS) * BUCKET_MS;
        try {
          await upsert(
            TABLES.TV_ANALYSIS,
            historyPartition(ticker, when),
            String(bucket).padStart(15, "0"),
            {
              ticker,
              symbol: body.symbol ?? ticker,
              net: p.net,
              bullScore: p.bullScore ?? 0,
              bearScore: p.bearScore ?? 0,
              verdict: p.verdict ?? "",
              price: p.price ?? null,
              computedAt: when.toISOString(),
            },
          );
          written++;
        } catch {
          /* individual point failures are tolerable; the chart is the source */
        }
      }),
    );
  }

  return { jsonBody: { status: "ok", ticker, received: points.length, written } };
}

async function tvHistoryHandler(req: HttpRequest): Promise<HttpResponseInit> {
  if (req.method === "POST") return backfillHandler(req);

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
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "tv-history",
  handler: tvHistoryHandler,
});
