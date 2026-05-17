import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, TABLES } from "../lib/tables.js";

/**
 * POST /api/scanner-alert
 *
 * Receives fresh-reversal alerts from the local TOS scanner
 * (tos-reversal-scanner repo: scanner/finviz_scanner.py → post_to_portal).
 * Authenticates with the shared TIMER_SECRET header. Writes one row to
 * ALERT_LOG using the same shape /api/day-trade-alerts already returns.
 *
 * Expected body:
 *   {
 *     "ticker": "ZM",
 *     "reversalPrice": 100.84,
 *     "revTime": "5/15 12:21",
 *     "source": "finviz",
 *     "status": "WHATSAPP" | "WHATSAPP_FAILED",
 *     "sl": 100.30,         // optional
 *     "slPct": -0.54        // optional
 *   }
 */

interface ScannerAlertBody {
  ticker?: string;
  reversalPrice?: number;
  revTime?: string;
  source?: string;
  status?: string;
  sl?: number;
  slPct?: number;
}

async function scannerAlertHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: ScannerAlertBody;
  try {
    body = (await req.json()) as ScannerAlertBody;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const ticker = (body.ticker || "").toUpperCase().trim();
  const reversalPrice = Number(body.reversalPrice);
  if (!ticker || !Number.isFinite(reversalPrice) || reversalPrice <= 0) {
    return { status: 400, jsonBody: { error: "ticker and reversalPrice required" } };
  }

  const firedAt = new Date().toISOString();
  const partitionKey = firedAt.slice(0, 10); // YYYY-MM-DD
  const rowKey = `${Date.now()}_${ticker}`;

  const row: Record<string, unknown> = {
    ticker,
    reversalPrice,
    firedAt,
    channel: "scanner",
    status: body.status || "WHATSAPP",
    ...(body.revTime ? { revTime: body.revTime } : {}),
    ...(body.source ? { source: body.source } : {}),
    ...(body.sl !== undefined ? { sl: body.sl } : {}),
    ...(body.slPct !== undefined ? { slPct: body.slPct } : {}),
  };

  try {
    await upsert(TABLES.ALERT_LOG, partitionKey, rowKey, row);
    return { jsonBody: { status: "ok", partitionKey, rowKey } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("scannerAlert", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "scanner-alert",
  handler: scannerAlertHandler,
});
