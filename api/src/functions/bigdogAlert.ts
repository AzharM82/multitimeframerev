import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, TABLES } from "../lib/tables.js";

/**
 * POST /api/bigdog-alert
 *
 * Receives scored intraday alerts from the BigDog scanner
 * (tools/bigdog-scanner/scanner/bigdog_scanner.py → post_to_portal). Auth via
 * the shared TIMER_SECRET header. Writes one row to BIGDOG_ALERTS with the full
 * signed-score payload flattened into typed columns (for research-agent queries)
 * plus the raw JSON blob for lossless replay.
 *
 * Body: ticker, direction (LONG|SHORT), listDir (bull|bear), score (signed),
 * onchartScore, computedScore, scoreMismatch, alertMin,
 * parts{rev,atr,vwap,vol,tick,stoch} (each -1|0|+1),
 * raw{rv_dir,rv_bars,rv_price,rv_time,rv_date,trend,buy_pct,sell_pct,tick_bal,
 * stoch_k,stoch_d,vwap_side,vwap,atr_side,atr}, ocr_misses[], ts, source.
 */

interface BigDogBody {
  ticker?: string;
  direction?: string;
  listDir?: string;
  score?: number;
  onchartScore?: number | null;
  computedScore?: number | null;
  scoreMismatch?: boolean;
  alertMin?: number;
  parts?: Record<string, number>;
  raw?: Record<string, unknown>;
  ocr_misses?: string[];
  ts?: string;
  source?: string;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function bigdogAlertHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: BigDogBody;
  try {
    body = (await req.json()) as BigDogBody;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const ticker = (body.ticker || "").toUpperCase().trim();
  const direction = (body.direction || "").toUpperCase().trim();
  const score = num(body.score);
  if (!ticker || (direction !== "LONG" && direction !== "SHORT") || score === null) {
    return { status: 400, jsonBody: { error: "ticker, direction (LONG|SHORT), score required" } };
  }

  const firedAt = body.ts || new Date().toISOString();
  const partitionKey = firedAt.slice(0, 10); // YYYY-MM-DD
  const rowKey = `${Date.now()}_${ticker}_${direction}`;

  const p = body.parts || {};
  const raw = body.raw || {};

  const row: Record<string, unknown> = {
    ticker,
    direction,
    listDir: body.listDir ?? null,
    score,
    onchartScore: num(body.onchartScore),
    computedScore: num(body.computedScore),
    scoreMismatch: !!body.scoreMismatch,
    alertMin: num(body.alertMin),
    firedAt,
    source: body.source || "bigdog-ocr",
    // per-metric signed contributions (-1 | 0 | +1)
    sRev: num(p.rev) ?? 0,
    sAtr: num(p.atr) ?? 0,
    sVwap: num(p.vwap) ?? 0,
    sVol: num(p.vol) ?? 0,
    sTick: num(p.tick) ?? 0,
    sStoch: num(p.stoch) ?? 0,
    // raw features
    rvDir: (raw.rv_dir as string) ?? null,
    rvBars: num(raw.rv_bars),
    rvPrice: num(raw.rv_price),
    rvTime: (raw.rv_time as string) ?? null,
    trend: (raw.trend as string) ?? null,
    buyPct: num(raw.buy_pct),
    sellPct: num(raw.sell_pct),
    tickBal: num(raw.tick_bal),
    stochK: num(raw.stoch_k),
    stochD: num(raw.stoch_d),
    vwapSide: (raw.vwap_side as string) ?? null,
    vwap: num(raw.vwap),
    atrSide: (raw.atr_side as string) ?? null,
    atr: num(raw.atr),
    ocrMisses: (body.ocr_misses || []).join(","),
    payloadJson: JSON.stringify(body),
  };

  try {
    await upsert(TABLES.BIGDOG_ALERTS, partitionKey, rowKey, row);
    return { jsonBody: { status: "ok", partitionKey, rowKey } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("bigdogAlert", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "bigdog-alert",
  handler: bigdogAlertHandler,
});
