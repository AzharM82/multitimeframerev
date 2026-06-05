import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { gunzipSync } from "zlib";
import { getOne, TABLES } from "../lib/tables.js";
import { fetchTickerRow } from "../lib/atrUniverse.js";
import { computeFromFinviz, finalizeAgainst, actionFinviz, type AtrStock } from "../lib/atrMatrix.js";

interface AtrSnapshotRow {
  partitionKey: string;
  rowKey: string;
  parts: number;
  [chunk: string]: unknown;
}

function decodeStocks(row: AtrSnapshotRow | null): AtrStock[] {
  if (!row) return [];
  let b64 = "";
  for (let i = 0; i < (row.parts ?? 0); i++) b64 += (row[`p${i}`] as string) ?? "";
  return b64 ? JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf-8")) : [];
}

/**
 * GET /api/atr-lookup?ticker=X — reverse lookup. Returns the full ATR-Matrix
 * card for any symbol: instantly if it's in the latest snapshot, otherwise
 * fetched live from Finviz and ranked against the snapshot universe.
 */
async function atrLookupHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const ticker = (req.query.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return { status: 400, jsonBody: { error: "ticker required" } };

  try {
    const stocks = decodeStocks(await getOne<AtrSnapshotRow>(TABLES.ATR_MATRIX, "latest", "snapshot"));

    const inUni = stocks.find((s) => s.ticker === ticker);
    if (inUni) {
      return { headers: { "Cache-Control": "no-store" }, jsonBody: { stock: inUni, inUniverse: true } };
    }

    const fv = await fetchTickerRow(ticker);
    if (!fv) return { status: 404, jsonBody: { error: "not_found", ticker } };
    const core = computeFromFinviz(fv);
    if (!core) return { status: 422, jsonBody: { error: "insufficient_data", ticker } };

    const named = { ...core, ticker: fv.ticker, company: fv.company, sector: fv.sector, industry: fv.industry, marketCap: fv.marketCap };
    const stock = finalizeAgainst(named, stocks, actionFinviz);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { stock, inUniverse: false } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("atrLookup", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "atr-lookup",
  handler: atrLookupHandler,
});
