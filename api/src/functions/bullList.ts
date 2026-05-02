import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, getOne, upsert, remove, TABLES } from "../lib/tables.js";
import { fetchLastTrade } from "../lib/polygon.js";

interface BullListRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  entry: number;
  sl: number;
  tp: number;
  rPct: number;
  status: "OPEN" | "TP_HIT" | "SL_HIT" | "EXPIRED";
  addedAt: string;
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  source: string;
  emailSubject: string;
  reversalBarTs: string;
}

async function getHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const status = (req.query.get("status") ?? "open").toLowerCase();
  const partition = status === "closed" ? "closed" : "open";

  const rows = await listByPartition<BullListRow>(TABLES.BULL_LIST, partition);

  // Live mark for open positions
  if (partition === "open" && rows.length > 0) {
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const last = await fetchLastTrade(r.ticker);
        const pnlPct = last !== null ? ((last - r.entry) / r.entry) * 100 : null;
        return { ...r, last, pnlPct };
      }),
    );
    enriched.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return { jsonBody: { status: partition, count: enriched.length, rows: enriched } };
  }

  rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return { jsonBody: { status: partition, count: rows.length, rows } };
}

async function postHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const body = (await req.json().catch(() => null)) as Partial<BullListRow> | null;
  if (!body || !body.ticker || typeof body.entry !== "number" || typeof body.sl !== "number" || typeof body.tp !== "number") {
    return { status: 400, jsonBody: { error: "ticker, entry, sl, tp required" } };
  }

  const date = new Date().toISOString().split("T")[0];
  const rowKey = `${date}_${body.ticker.toUpperCase()}`;
  const row: BullListRow = {
    partitionKey: "open",
    rowKey,
    ticker: body.ticker.toUpperCase(),
    entry: body.entry,
    sl: body.sl,
    tp: body.tp,
    rPct: body.rPct ?? 0,
    status: "OPEN",
    addedAt: new Date().toISOString(),
    source: body.source ?? "manual",
    emailSubject: body.emailSubject ?? "",
    reversalBarTs: body.reversalBarTs ?? "",
  };
  await upsert(TABLES.BULL_LIST, "open", rowKey, row);
  return { jsonBody: { status: "ok", row } };
}

async function deleteHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const rowKey = req.query.get("rowKey");
  const partition = req.query.get("partition") ?? "open";
  if (!rowKey) return { status: 400, jsonBody: { error: "rowKey required" } };

  const existing = await getOne<BullListRow>(TABLES.BULL_LIST, partition, rowKey);
  if (!existing) return { status: 404, jsonBody: { error: "not found" } };

  await remove(TABLES.BULL_LIST, partition, rowKey);
  return { jsonBody: { status: "ok", removed: rowKey } };
}

async function bullListHandler(req: HttpRequest): Promise<HttpResponseInit> {
  if (req.method === "GET") return getHandler(req);
  if (req.method === "POST") return postHandler(req);
  if (req.method === "DELETE") return deleteHandler(req);
  return { status: 405, jsonBody: { error: "method not allowed" } };
}

app.http("bullList", {
  methods: ["GET", "POST", "DELETE"],
  authLevel: "anonymous",
  route: "bull-list",
  handler: bullListHandler,
});
