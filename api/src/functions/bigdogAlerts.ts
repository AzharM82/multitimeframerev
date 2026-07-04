import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, listAll, TABLES } from "../lib/tables.js";

/**
 * GET /api/bigdog-alerts?date=YYYY-MM-DD
 *
 * Reads the BigDogAlerts table (written by the BigDog scanner via POST
 * /api/bigdog-alert). One row per fired alert; partitionKey = date. Powers the
 * BIGD-Intraday tab. Anonymous read (no secret) like the other GET endpoints.
 *
 * - date given → all alerts that day (newest first).
 * - no date    → latest day's alerts + list of available dates.
 */

interface BigDogAlertRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  direction: string;
  listDir?: string;
  score: number;
  onchartScore?: number | null;
  computedScore?: number | null;
  scoreMismatch?: boolean;
  alertMin?: number;
  firedAt: string;
  source?: string;
  sRev?: number;
  sAtr?: number;
  sVwap?: number;
  sVol?: number;
  sTick?: number;
  sStoch?: number;
  rvDir?: string;
  rvBars?: number;
  rvPrice?: number;
  rvTime?: string;
  trend?: string;
  buyPct?: number;
  sellPct?: number;
  tickBal?: number;
  stochK?: number;
  stochD?: number;
  stochSide?: string;
  vwapSide?: string;
  vwap?: number;
  atrSide?: string;
  atr?: number;
  ocrMisses?: string;
}

function toHit(r: BigDogAlertRow) {
  return {
    firedAt: r.firedAt,
    ticker: r.ticker,
    direction: r.direction,
    listDir: r.listDir ?? null,
    score: r.score,
    onchartScore: r.onchartScore ?? null,
    computedScore: r.computedScore ?? null,
    scoreMismatch: !!r.scoreMismatch,
    alertMin: r.alertMin ?? null,
    parts: {
      rev: r.sRev ?? 0, atr: r.sAtr ?? 0, vwap: r.sVwap ?? 0,
      vol: r.sVol ?? 0, tick: r.sTick ?? 0, stoch: r.sStoch ?? 0,
    },
    rvDir: r.rvDir ?? null,
    rvBars: r.rvBars ?? null,
    rvPrice: r.rvPrice ?? null,
    rvTime: r.rvTime ?? null,
    trend: r.trend ?? null,
    buyPct: r.buyPct ?? null,
    tickBal: r.tickBal ?? null,
    stochK: r.stochK ?? null,
    stochD: r.stochD ?? null,
    stochSide: r.stochSide ?? null,
    vwapSide: r.vwapSide ?? null,
    atrSide: r.atrSide ?? null,
    ocrMisses: r.ocrMisses ? r.ocrMisses.split(",").filter(Boolean) : [],
  };
}

async function bigdogAlertsHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const date = req.query.get("date");
  try {
    if (date) {
      const rows = await listByPartition<BigDogAlertRow>(TABLES.BIGDOG_ALERTS, date);
      rows.sort((a, b) => (b.firedAt || "").localeCompare(a.firedAt || ""));
      return { headers: { "Cache-Control": "no-store" }, jsonBody: {
        date, totalHits: rows.length, hits: rows.map(toHit),
      } };
    }

    const all = await listAll<BigDogAlertRow>(TABLES.BIGDOG_ALERTS);
    if (all.length === 0) {
      return { jsonBody: { date: null, totalHits: 0, hits: [], available: [] } };
    }
    const byDate = new Map<string, number>();
    for (const r of all) byDate.set(r.partitionKey, (byDate.get(r.partitionKey) ?? 0) + 1);
    const available = [...byDate.entries()]
      .map(([d, count]) => ({ date: d, totalHits: count }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30);
    const latestDate = available[0].date;
    const rows = all.filter((r) => r.partitionKey === latestDate);
    rows.sort((a, b) => (b.firedAt || "").localeCompare(a.firedAt || ""));
    return { headers: { "Cache-Control": "no-store" }, jsonBody: {
      date: latestDate, totalHits: rows.length, hits: rows.map(toHit), available,
    } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("bigdogAlerts", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "bigdog-alerts",
  handler: bigdogAlertsHandler,
});
