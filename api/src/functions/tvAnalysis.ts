import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, getOne, TABLES } from "../lib/tables.js";

/**
 * TradingView chart analysis: sidecar writes, portal reads.
 *
 *   POST /api/tv-analysis   (x-timer-secret)  <- sidecar publishes a result
 *   GET  /api/tv-analysis?ticker=NSE:NIFTY    <- portal reads the latest
 *
 * The scoring happens entirely on the desktop (tools/tv-sidecar). Nothing here
 * computes signals - this endpoint is storage plus a staleness stamp.
 *
 * POST stays anonymous at the SWA routing layer (machine caller) and is
 * authenticated by the shared TIMER_SECRET header instead, same as
 * /api/bigdog-alert and /api/scanner-alert.
 */

interface AnalysisBody {
  /** What the user typed, e.g. "NIFTY". The key the portal reads back by. */
  ticker?: string;
  /** What TradingView resolved it to, e.g. "NSE:NIFTY". For display only. */
  symbol?: string;
  requestId?: string;
  verdict?: string;
  dailyBias?: string | null;
  bullScore?: number;
  bearScore?: number;
  net?: number;
  price?: number;
  resolution?: string;
  bullish?: unknown[];
  bearish?: unknown[];
  gateFailures?: string[];
  meta?: Record<string, unknown>;
  error?: string;
}

interface AnalysisRow {
  symbol: string;
  requestId: string;
  verdict: string;
  computedAt: string;
  payloadJson: string;
}

const PARTITION = "result";

/** Azure Table caps a single property at 64KB; keep well clear of it. */
const MAX_PAYLOAD_BYTES = 48_000;

/** Bar size the history is bucketed to, matching the sidecar's refresh. */
const BUCKET_MS = 10 * 60 * 1000;

/**
 * History partition key. UTC date deliberately: both the US and Indian sessions
 * fall wholly inside one UTC day (NSE 03:45-10:00Z, US 13:30-20:00Z), so no
 * session is ever split across two partitions.
 */
export function historyPartition(ticker: string, when: Date): string {
  return `hist_${ticker}_${when.toISOString().slice(0, 10)}`;
}

/**
 * Row key is the 10-minute bucket the reading falls in, zero-padded so Azure
 * Table's lexical row ordering is also chronological. Bucketing means a restart
 * or a manual refresh overwrites that bar rather than adding a duplicate point.
 */
function historyRowKey(when: Date): string {
  const bucket = Math.floor(when.getTime() / BUCKET_MS) * BUCKET_MS;
  return String(bucket).padStart(15, "0");
}

async function tvAnalysisHandler(req: HttpRequest): Promise<HttpResponseInit> {
  if (req.method === "GET") {
    const ticker = (req.query.get("ticker") || "").toUpperCase().trim();
    if (!ticker) return { status: 400, jsonBody: { error: "ticker required" } };

    const row = await getOne<AnalysisRow>(TABLES.TV_ANALYSIS, PARTITION, ticker);
    if (!row) return { status: 404, jsonBody: { error: "no analysis yet", ticker } };

    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      return { status: 500, jsonBody: { error: "stored payload is corrupt", ticker } };
    }

    const ageSeconds = Math.round((Date.now() - new Date(row.computedAt).getTime()) / 1000);
    return {
      jsonBody: {
        ...(payload as object),
        computedAt: row.computedAt,
        requestId: row.requestId,
        // Surfaced so the UI can mark a reading stale rather than render a
        // frozen result as if it were live.
        ageSeconds,
      },
    };
  }

  // POST — sidecar publishes
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: AnalysisBody;
  try {
    body = (await req.json()) as AnalysisBody;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  // Key by the REQUESTED ticker, falling back to the resolved symbol for older
  // publishers. Keying by the resolved symbol alone stored a request for
  // "NIFTY" under "NSE:NIFTY", so the portal polled a row that never existed.
  const symbol = (body.ticker || body.symbol || "").toUpperCase().trim();
  if (!symbol) return { status: 400, jsonBody: { error: "ticker or symbol required" } };

  const payloadJson = JSON.stringify(body);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    return { status: 413, jsonBody: { error: "payload too large for table storage" } };
  }

  const row: AnalysisRow = {
    symbol,
    requestId: body.requestId || "",
    verdict: body.verdict || (body.error ? "ERROR" : "UNKNOWN"),
    computedAt: new Date().toISOString(),
    payloadJson,
  };

  try {
    await upsert(TABLES.TV_ANALYSIS, PARTITION, symbol, row);

    // Append to the day's trend history. Errors here must NOT fail the publish:
    // losing one history point is cosmetic, losing the reading is not.
    if (!body.error && typeof body.net === "number") {
      const when = new Date(row.computedAt);
      try {
        await upsert(TABLES.TV_ANALYSIS, historyPartition(symbol, when), historyRowKey(when), {
          ticker: symbol,
          symbol: body.symbol ?? symbol,
          net: body.net,
          bullScore: body.bullScore ?? 0,
          bearScore: body.bearScore ?? 0,
          verdict: body.verdict ?? "",
          price: body.price ?? null,
          computedAt: row.computedAt,
        });
      } catch {
        /* history is best-effort */
      }
    }

    return { jsonBody: { status: "ok", symbol, computedAt: row.computedAt } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("tvAnalysis", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "tv-analysis",
  handler: tvAnalysisHandler,
});
