import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listAll, TABLES } from "../lib/tables.js";
import { fetchAllSnapshots } from "../lib/polygonSnapshot.js";

interface AlertLogRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
  status?: string;
  sl?: number;
  slPct?: number;
  currentPrice?: number;
}

async function dayTradeAlertsHandler(req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.get("limit") ?? "100")));

    const all = await listAll<AlertLogRow>(TABLES.ALERT_LOG).catch(() => [] as AlertLogRow[]);
    const recent = all
      .sort((a, b) => (b.firedAt ?? "").localeCompare(a.firedAt ?? ""))
      .slice(0, limit);

    // Enrich each row with live last-trade price so the UI can render
    // $1000 paper-trade P&L and target-distance. Snapshot failures are
    // non-fatal — currentPrice stays undefined and the UI renders "—".
    if (recent.length > 0 && process.env.POLYGON_API_KEY) {
      try {
        const tickers = Array.from(new Set(recent.map((r) => r.ticker)));
        const snapshots = await fetchAllSnapshots(tickers);
        for (const r of recent) {
          const snap = snapshots.get(r.ticker);
          // Fallback chain: live trade → minute bar → today's close →
          // previous day's close. The last one keeps the column populated
          // overnight / weekends when no fresh print is available.
          const price =
            snap?.lastTrade?.p ?? snap?.min?.c ?? snap?.day?.c ?? snap?.prevDay?.c;
          if (typeof price === "number" && price > 0) {
            r.currentPrice = price;
          }
        }
      } catch {
        // ignore — UI handles missing currentPrice
      }
    }

    return { jsonBody: { total: all.length, recent } };
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
