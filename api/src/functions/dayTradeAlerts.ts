import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listAll, TABLES } from "../lib/tables.js";

interface AlertLogRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
  status: string;
}

const RECENT_LIMIT = 50;

async function dayTradeAlertsHandler(_req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const all = await listAll<AlertLogRow>(TABLES.ALERT_LOG);
    all.sort((a, b) => a.firedAt.localeCompare(b.firedAt));
    return {
      jsonBody: {
        total: all.length,
        recent: all.slice(-RECENT_LIMIT).reverse(),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("dayTradeAlerts", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "day-trade-alerts",
  handler: dayTradeAlertsHandler,
});
