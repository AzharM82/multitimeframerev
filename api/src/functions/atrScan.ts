import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { gunzipSync } from "zlib";
import { getOne, TABLES } from "../lib/tables.js";

interface AtrSnapshotRow {
  partitionKey: string;
  rowKey: string;
  generated: string;
  asOf: string;
  count: number;
  avgAtrPct: number;
  pctAboveSMA50: number;
  buyable: number;
  extended7: number;
  parts: number;
  [chunk: string]: unknown; // p0..pN base64 chunks of the gzipped stocks array
}

/** GET /api/atr-scan — returns the latest EOD ATR Matrix snapshot. The stocks
 *  array is stored gzipped + base64, split across p0..pN properties (each under
 *  the 64KB Table limit); we reassemble + decode it so the browser receives
 *  plain JSON. */
async function atrScanHandler(_req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const row = await getOne<AtrSnapshotRow>(TABLES.ATR_MATRIX, "latest", "snapshot");
    if (!row) {
      return { status: 503, jsonBody: { error: "no_snapshot", message: "Run the scan first." } };
    }
    let b64 = "";
    for (let i = 0; i < (row.parts ?? 0); i++) b64 += (row[`p${i}`] as string) ?? "";
    const stocks = b64
      ? JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf-8"))
      : [];
    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        generated: row.generated,
        asOf: row.asOf,
        count: row.count,
        avgAtrPct: row.avgAtrPct,
        pctAboveSMA50: row.pctAboveSMA50,
        buyable: row.buyable,
        extended7: row.extended7,
        stocks,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("atrScan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "atr-scan",
  handler: atrScanHandler,
});
