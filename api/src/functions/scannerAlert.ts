import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, listByPartition, TABLES } from "../lib/tables.js";

interface AlertLogRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
  status: string;
}

interface ScannerAlertBody {
  ticker: string;
  reversalPrice: number;
  revTime?: string;       // "M/D HH:MM" from the OCR label
  source?: string;        // e.g. "finviz" or "watchlist"
  status?: string;        // e.g. "WHATSAPP" or "WHATSAPP_FALLBACK"
}

const DEDUP_MINUTES = 30;

async function isDedupedHit(ticker: string): Promise<boolean> {
  const date = new Date().toISOString().split("T")[0];
  const recent = await listByPartition<AlertLogRow>(TABLES.ALERT_LOG, date);
  const cutoff = Date.now() - DEDUP_MINUTES * 60_000;
  return recent.some(
    (r) => r.ticker === ticker && r.channel === "scanner" && new Date(r.firedAt).getTime() > cutoff,
  );
}

async function scannerAlertHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: ScannerAlertBody | null = null;
  try {
    body = (await req.json()) as ScannerAlertBody;
  } catch {
    return { status: 400, jsonBody: { error: "invalid JSON body" } };
  }
  if (!body || !body.ticker || typeof body.reversalPrice !== "number") {
    return { status: 400, jsonBody: { error: "ticker and reversalPrice required" } };
  }

  const ticker = body.ticker.toUpperCase();

  if (await isDedupedHit(ticker)) {
    return { jsonBody: { status: "deduped", ticker } };
  }

  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const rowKey = `${now.getTime()}_${ticker}`;
  const row: AlertLogRow = {
    partitionKey: date,
    rowKey,
    ticker,
    reversalPrice: body.reversalPrice,
    firedAt: now.toISOString(),
    channel: "scanner",
    status: body.status ?? "WHATSAPP",
  };
  await upsert(TABLES.ALERT_LOG, date, rowKey, row);

  return {
    jsonBody: {
      status: "logged",
      ticker,
      revTime: body.revTime ?? null,
      source: body.source ?? null,
    },
  };
}

app.http("scannerAlert", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "scanner-alert",
  handler: scannerAlertHandler,
});
