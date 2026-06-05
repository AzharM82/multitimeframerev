import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { gzipSync } from "zlib";
import { fetchDailyBarsExtended } from "../lib/polygon.js";
import { pullUniverse } from "../lib/atrUniverse.js";
import { computeStock, finalize, MIN_BARS, type AtrStock } from "../lib/atrMatrix.js";
import { upsert, TABLES } from "../lib/tables.js";
import { pacificDateKey } from "../lib/dates.js";

// Polygon-friendly batching (same shape as the AVWAP EOD timer).
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function todayKey(): string {
  return pacificDateKey();
}

/**
 * Run the EOD ATR Matrix scan: Finviz screen → Polygon daily bars (2y) →
 * per-ticker metrics → universe-relative finalize().
 */
async function runScan(ctx: InvocationContext): Promise<AtrStock[]> {
  const universe = await pullUniverse();
  const tickers = [...universe.keys()];
  ctx.log(`ATR Matrix scan: ${tickers.length} tickers from Finviz screen`);

  type Core = NonNullable<ReturnType<typeof computeStock>> & {
    ticker: string; company: string; sector: string; industry: string; marketCap: number;
  };
  const rows: Core[] = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (t) => {
        try {
          const bars = await fetchDailyBarsExtended(t, 2);
          if (bars.length < MIN_BARS) return null;
          const core = computeStock(bars);
          if (!core) return null;
          const fv = universe.get(t)!;
          return {
            ...core,
            ticker: t,
            company: fv.company,
            sector: fv.sector,
            industry: fv.industry,
            marketCap: fv.marketCap,
          } as Core;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) rows.push(r);
    if (i + BATCH_SIZE < tickers.length) await sleep(BATCH_DELAY_MS);
  }

  return finalize(rows);
}

interface AtrSnapshot {
  generated: string;
  asOf: string;
  count: number;
  avgAtrPct: number;
  pctAboveSMA50: number;
  buyable: number;
  extended7: number;
  stocks: AtrStock[];
}

function buildSnapshot(stocks: AtrStock[]): AtrSnapshot {
  const above = stocks.filter((r) => r.aboveSMA50).length;
  return {
    generated: new Date().toISOString(),
    asOf: todayKey(),
    count: stocks.length,
    avgAtrPct: stocks.length ? Math.round((stocks.reduce((a, r) => a + r.atrPct, 0) / stocks.length) * 100) / 100 : 0,
    pctAboveSMA50: stocks.length ? Math.round((1000 * above) / stocks.length) / 10 : 0,
    buyable: stocks.filter((r) => r.action === "buy").length,
    extended7: stocks.filter((r) => r.bucket >= 7).length,
    stocks,
  };
}

// Azure Table caps each string property at 64KB (32K UTF-16 chars). The gzipped
// stocks payload (base64) routinely exceeds that — floats compress poorly — so
// we split it across p0..pN properties (≤32K chars each) on the single "latest"
// snapshot entity. atrScan reads `parts` and reassembles.
const CHUNK_CHARS = 30000;

/**
 * Persist the snapshot under the fixed "latest" partition — the swing dashboard
 * only needs the most recent EOD snapshot.
 */
async function persist(snap: AtrSnapshot): Promise<void> {
  const b64 = gzipSync(Buffer.from(JSON.stringify(snap.stocks))).toString("base64");
  const chunks: Record<string, string> = {};
  let parts = 0;
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) {
    chunks[`p${parts}`] = b64.slice(i, i + CHUNK_CHARS);
    parts++;
  }
  await upsert(TABLES.ATR_MATRIX, "latest", "snapshot", {
    generated: snap.generated,
    asOf: snap.asOf,
    count: snap.count,
    avgAtrPct: snap.avgAtrPct,
    pctAboveSMA50: snap.pctAboveSMA50,
    buyable: snap.buyable,
    extended7: snap.extended7,
    parts,
    ...chunks,
  });
}

async function atrEodHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  try {
    const stocks = await runScan(ctx);
    const snap = buildSnapshot(stocks);
    await persist(snap);
    ctx.log(`ATR Matrix snapshot: ${snap.count} stocks, buyable=${snap.buyable}, 7x+=${snap.extended7}`);
    return {
      jsonBody: {
        status: "ok",
        asOf: snap.asOf,
        count: snap.count,
        buyable: snap.buyable,
        extended7: snap.extended7,
        avgAtrPct: snap.avgAtrPct,
        pctAboveSMA50: snap.pctAboveSMA50,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`atrEodTimer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("atrEodTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "atr-eod-timer",
  handler: atrEodHandler,
});
