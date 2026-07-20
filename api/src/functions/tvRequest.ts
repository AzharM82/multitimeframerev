import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, getOne, TABLES } from "../lib/tables.js";

/**
 * Ticker request mailbox for the TradingView sidecar.
 *
 * The portal runs in Azure; the sidecar runs on the trading desktop behind a
 * home router with no inbound path. So the cloud cannot call the sidecar - it
 * acts as a mailbox the sidecar polls instead.
 *
 *   POST /api/tv-request  { ticker }   <- portal drops a request
 *   GET  /api/tv-request               <- sidecar polls for the latest one
 *
 * GET must stay anonymous: the sidecar is a machine caller and cannot complete
 * a Google sign-in. See staticwebapp.config.json.
 */

interface RequestRow {
  ticker: string;
  requestId: string;
  requestedAt: string;
}

const PARTITION = "request";
const ROW = "current";

async function tvRequestHandler(req: HttpRequest): Promise<HttpResponseInit> {
  if (req.method === "GET") {
    const row = await getOne<RequestRow>(TABLES.TV_ANALYSIS, PARTITION, ROW);
    if (!row) return { jsonBody: { ticker: null } };
    return {
      jsonBody: {
        ticker: row.ticker,
        requestId: row.requestId,
        requestedAt: row.requestedAt,
      },
    };
  }

  // POST — portal asks for a ticker
  let body: { ticker?: string };
  try {
    body = (await req.json()) as { ticker?: string };
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const ticker = (body.ticker || "").toUpperCase().trim();
  // Exchange-qualified symbols are normal here (NSE:NIFTY, BATS:NBIS).
  if (!ticker || !/^[A-Z0-9._:!-]{1,32}$/.test(ticker)) {
    return { status: 400, jsonBody: { error: "valid ticker required" } };
  }

  const requestedAt = new Date().toISOString();
  const requestId = `${Date.now()}_${ticker}`;

  try {
    await upsert(TABLES.TV_ANALYSIS, PARTITION, ROW, { ticker, requestId, requestedAt });
    return { jsonBody: { status: "queued", ticker, requestId, requestedAt } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("tvRequest", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "tv-request",
  handler: tvRequestHandler,
});
