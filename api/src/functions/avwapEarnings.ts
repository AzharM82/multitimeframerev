import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { recordSnapshot, getSnapshot, type AvwapInputRow } from "../lib/avwapEarnings.js";
import { cacheGet, cacheSet, type Quote } from "../lib/rotation.js";
import { fetchQuotesFinviz } from "../lib/rotationFinviz.js";

/**
 * Live change / change-from-open for the swept universe.
 *
 * Sourced from FinViz Elite, the same feed the Rotation and Sector Desk tabs
 * use, so the change column agrees with the rest of the portal rather than
 * quietly disagreeing by a few basis points. Cached 30s - the same TTL as
 * /api/rot-quotes - because the tab polls every 60s per viewer and one
 * whole-market export should not be pulled per viewer per minute.
 *
 * Deliberately NOT fatal: the levels are the point of this tab, and they come
 * off the chart. If FinViz is unconfigured, rate-limited or down, the change
 * columns render blank and everything else still works. `quote_source` rides in
 * the payload so the UI can say which clock the numbers are on instead of
 * asserting a freshness it cannot verify.
 */
const QUOTE_CACHE_KEY = "avwap:quotes";
const QUOTE_CACHE_TTL = 30;

async function quotesFor(tickers: string[]): Promise<{ quotes: Record<string, Quote>; source: string; missing: number }> {
  const cached = await cacheGet<{ quotes: Record<string, Quote>; source: string; missing: number }>(QUOTE_CACHE_KEY);
  if (cached) return cached;
  try {
    const fv = await fetchQuotesFinviz(tickers);
    const out = fv
      ? { quotes: fv.quotes, source: "finviz", missing: fv.missing.length }
      : { quotes: {}, source: "none", missing: tickers.length };
    await cacheSet(QUOTE_CACHE_KEY, out, QUOTE_CACHE_TTL);
    return out;
  } catch {
    return { quotes: {}, source: "none", missing: tickers.length };
  }
}

/**
 * GET/POST /api/avwap-earnings — four chart levels for the MASTER watchlist.
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
 *   "levels": ["avwap","sma50","ema21d","sma50d"],
 *   "rows": [{ ticker, close, last_bar_closed,
 *              closed_time, prev_time, closed_close, prev_close,
 *              <level>,        the plotted level value on the live bar
 *              pct_<level>,    live close distance from it   (display)
 *              c_pct_<level>,  last CLOSED candle's distance (alerting)
 *              p_pct_<level>   the candle before that        (alerting)
 *            }]
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
      const q = await quotesFor(snap.rows.map((r) => r.ticker));
      const rows = snap.rows.map((r) => {
        const quote = q.quotes[r.ticker];
        return {
          ...r,
          chgPct: quote ? quote.changePercent : null,
          chgOpenPct: quote ? quote.changeFromOpenPercent : null,
        };
      });
      return {
        jsonBody: {
          rows,
          quote_source: q.source,
          quote_missing: q.missing,
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
