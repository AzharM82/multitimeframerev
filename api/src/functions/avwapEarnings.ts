import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { recordSnapshot, getSnapshot, type AvwapInputRow } from "../lib/avwapEarnings.js";

/**
 * GET/POST /api/avwap-earnings — AVWAP(Earnings) + 21/50 EMA for the MASTER watchlist.
 *
 * POST (publisher: tools/tv-avwap/publish_avwap.mjs on DESKTOP2) — x-timer-secret.
 * Anonymous in staticwebapp.config.json for POST ONLY; the secret is the real
 * gate. GET stays behind the `portal` role like the rest of /api/* — the tab is
 * the only reader and it is already authenticated, so there is no reason to
 * expose the whole watchlist publicly.
 *
 * Body:
 * {
 *   "bar_utc": "2026-08-14T19:21:00.000Z",   last closed 39m bar of the sweep
 *   "published_at": "2026-08-15T04:10:00Z",  optional; defaults to server now
 *   "host": "DESKTOP2",
 *   "resolution": "39", "anchor": "Earnings", "watchlist": "MASTER",
 *   "failed": ["ABC"],                       symbols the sweep could not read
 *   "rows": [{ ticker, close, avwap, ema21, ema50,
 *              pct_avwap, pct_ema21, pct_ema50,          <- live bar (display)
 *              last_bar_closed, closed_time, prev_time,
 *              closed_close, prev_close,
 *              c_pct_avwap, p_pct_avwap,                 <- last two CLOSED
 *              c_pct_ema21, p_pct_ema21,                    bars (alerting)
 *              c_pct_ema50, p_pct_ema50 }]
 * }
 *
 * Response echoes any line crossings the sweep produced, so the publisher log
 * shows what alerted without a second round trip.
 */

interface PostBody {
  bar_utc?: string;
  published_at?: string;
  host?: string;
  failed?: unknown;
  rows?: unknown;
}

async function handler(req: HttpRequest): Promise<HttpResponseInit> {
  if (req.method === "GET") {
    try {
      const snap = await getSnapshot();
      return {
        jsonBody: {
          rows: snap.rows,
          count: snap.rows.length,
          bar_utc: snap.barUtc,
          published_at: snap.publishedAt,
          received_at: snap.receivedAt,
          host: snap.host,
          age_min: snap.ageMin,
          stale: snap.stale,
          failed: snap.failed,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { status: 500, jsonBody: { error: message } };
    }
  }

  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: 400, jsonBody: { error: "rows must be a non-empty array" } };
  }

  const failed = Array.isArray(body.failed) ? body.failed.map((t) => String(t)) : [];

  try {
    const res = await recordSnapshot(rows as AvwapInputRow[], {
      barUtc: String(body.bar_utc ?? ""),
      publishedAt: String(body.published_at ?? ""),
      host: String(body.host ?? ""),
      failed,
    });
    return {
      jsonBody: {
        status: "ok",
        stored: res.stored,
        skipped: res.skipped,
        failed: failed.length,
        crossings: res.crossings.map((c) => ({
          ticker: c.ticker,
          level: c.level,
          direction: c.direction,
          prev_pct: Number(c.prevPct.toFixed(2)),
          pct: Number(c.pct.toFixed(2)),
          close: c.close,
          level_value: c.levelValue,
          bar_utc: new Date(c.barTime * 1000).toISOString(),
        })),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("avwapEarnings", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "avwap-earnings",
  handler,
});
