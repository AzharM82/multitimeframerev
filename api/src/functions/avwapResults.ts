import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { getOne, listAll, TABLES } from "../lib/tables.js";

interface AvwapSummaryRow {
  partitionKey: string;
  rowKey: string;
  date: string;
  totalHits: number;
  payload: string;
  updatedAt: string;
}

async function avwapResultsHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const date = req.query.get("date");

  try {
    if (date) {
      const row = await getOne<AvwapSummaryRow>(TABLES.AVWAP_RESULTS, date, "summary");
      if (!row) return { jsonBody: { date, totalHits: 0, hits: [] } };
      return {
        jsonBody: {
          date: row.date,
          totalHits: row.totalHits,
          updatedAt: row.updatedAt,
          hits: JSON.parse(row.payload),
        },
      };
    }

    // No date — return latest summary + a list of recent dates available.
    const all = await listAll<AvwapSummaryRow>(TABLES.AVWAP_RESULTS);
    if (all.length === 0) return { jsonBody: { date: null, totalHits: 0, hits: [], available: [] } };
    all.sort((a, b) => b.date.localeCompare(a.date));
    const latest = all[0];
    return {
      jsonBody: {
        date: latest.date,
        totalHits: latest.totalHits,
        updatedAt: latest.updatedAt,
        hits: JSON.parse(latest.payload),
        available: all.slice(0, 30).map((r) => ({ date: r.date, totalHits: r.totalHits })),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("avwapResults", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "avwap-results",
  handler: avwapResultsHandler,
});
