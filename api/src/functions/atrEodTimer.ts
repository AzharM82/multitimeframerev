import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { gzipSync } from "zlib";
import { pullMatrixUniverse } from "../lib/atrUniverse.js";
import { computeFromFinviz, finalize, actionFinviz, type AtrStock } from "../lib/atrMatrix.js";
import { upsert, TABLES } from "../lib/tables.js";
import { pacificDateKey } from "../lib/dates.js";

function todayKey(): string {
  return pacificDateKey();
}

/**
 * Run the EOD ATR Matrix scan: pull the S&P 500 + Nasdaq 100 from Finviz (one
 * call per index, all metrics in the columns) → compute per-ticker → finalize.
 * No Polygon: the whole index map is computed from the Finviz response.
 */
async function runScan(ctx: InvocationContext): Promise<AtrStock[]> {
  const universe = await pullMatrixUniverse();
  ctx.log(`ATR Matrix: ${universe.length} index constituents (S&P 500 + Nasdaq 100)`);

  type Core = NonNullable<ReturnType<typeof computeFromFinviz>> & {
    ticker: string; company: string; sector: string; industry: string; marketCap: number;
  };
  const rows: Core[] = [];
  for (const r of universe) {
    const core = computeFromFinviz(r);
    if (!core) continue;
    rows.push({ ...core, ticker: r.ticker, company: r.company, sector: r.sector, industry: r.industry, marketCap: r.marketCap });
  }

  return finalize(rows, actionFinviz);
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
