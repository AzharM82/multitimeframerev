import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { gzipSync, gunzipSync } from "zlib";
import { upsert, getOne, listAll, TABLES } from "../lib/tables.js";
import { fetchDailyBarsExtended } from "../lib/polygon.js";
import { computeMaStack, type MaStack } from "../lib/swing/maStack.js";
import { computeReversal, type ReversalRead } from "../lib/swing/reversal.js";
import { loadUniverse } from "./swingUniverse.js";

/**
 * Swing Strength — the nightly scan and its reader.
 *
 *   POST /api/swing-scan              score the whole universe now (cron 5:00 PM ET; timer secret or portal session)
 *   GET  /api/swing-results[?date=]   one day's rows (latest by default) + the list of stored days
 *
 * Phase 1 computes Lens 1 (the daily MA stack). Lenses 2 (reversal) and 3
 * (Weinstein stage) are `null` placeholders in the row so the shape does not
 * change when they land. Bars come from Polygon daily aggregates (the stocks
 * plan covers them); two years is enough for a settled 200 SMA and, later,
 * for the 30-week average and its slope.
 *
 * Storage: one gzip+base64 blob per ET day, chunked into p0..pN (Azure Table
 * caps a property at 64KB) under PK = date, RK = "snapshot"; a copy under
 * PK = "latest" so the tab needs no date scan.
 */

export interface SwingRow {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCapM: number | null;
  extras: Record<string, number>;
  /** ET date of the last daily bar used. */
  asOf: string | null;
  ma: MaStack | null;
  reversal: ReversalRead | null;
  stage: null;
  error?: string;
}

export interface SwingSnapshot {
  date: string;
  generatedAt: string;
  count: number;
  scored: number;
  failed: number;
  rows: SwingRow[];
}

const CHUNK_CHARS = 30_000;
const CONCURRENCY = 8;

function authorized(req: HttpRequest): boolean {
  const signedIn = !!req.headers.get("x-ms-client-principal");
  const viaSecret = !!process.env.TIMER_SECRET && req.headers.get("x-timer-secret") === process.env.TIMER_SECRET;
  return signedIn || viaSecret;
}

const etDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function scoreAll(ctx: InvocationContext): Promise<SwingSnapshot> {
  const universe = await loadUniverse();
  if (!universe.length) throw new Error("universe is empty — upload a FinViz export first");
  const startedAt = Date.now();
  let lastBar = "";
  const rows = await pool(universe, CONCURRENCY, async (u): Promise<SwingRow> => {
    const base = { ticker: u.ticker, company: u.company, sector: u.sector, industry: u.industry, marketCapM: u.marketCapM, extras: u.extras, reversal: null as ReversalRead | null, stage: null } as const;
    try {
      const bars = await fetchDailyBarsExtended(u.ticker, 2);
      if (bars.length < 30) return { ...base, asOf: null, ma: null, error: `only ${bars.length} daily bars` };
      const closes = bars.map((b) => b.close);
      const asOf = etDate(new Date(bars[bars.length - 1].timestamp));
      if (asOf > lastBar) lastBar = asOf;
      return { ...base, asOf, ma: computeMaStack(closes), reversal: computeReversal(bars) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.warn(`swing-scan ${u.ticker}: ${message}`);
      return { ...base, asOf: null, ma: null, error: message.slice(0, 160) };
    }
  });
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const snap: SwingSnapshot = {
    date: lastBar || etDate(),
    generatedAt: new Date().toISOString(),
    count: rows.length,
    scored: rows.filter((r) => r.ma).length,
    failed: rows.filter((r) => !r.ma).length,
    rows,
  };
  ctx.log(`swing-scan: ${snap.scored}/${snap.count} scored for ${snap.date} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return snap;
}

async function store(snap: SwingSnapshot): Promise<void> {
  const b64 = gzipSync(Buffer.from(JSON.stringify(snap))).toString("base64");
  const chunks: Record<string, string> = {};
  let parts = 0;
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) { chunks[`p${parts}`] = b64.slice(i, i + CHUNK_CHARS); parts++; }
  const row = { date: snap.date, generatedAt: snap.generatedAt, count: snap.count, scored: snap.scored, failed: snap.failed, parts, ...chunks };
  await upsert(TABLES.SWING_SCAN, snap.date, "snapshot", row);
  await upsert(TABLES.SWING_SCAN, "latest", "snapshot", row);
}

interface StoredSnap { partitionKey: string; date?: string; generatedAt?: string; count?: number; scored?: number; failed?: number; parts?: number; [k: string]: unknown }

function inflate(row: StoredSnap | null): SwingSnapshot | null {
  if (!row || !row.parts) return null;
  let b64 = "";
  for (let i = 0; i < row.parts; i++) b64 += (row[`p${i}`] as string) ?? "";
  try { return JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf-8")) as SwingSnapshot; }
  catch { return null; }
}

async function scan(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!authorized(req)) return { status: 401, jsonBody: { error: "Unauthorized" } };
  const snap = await scoreAll(ctx);
  await store(snap);
  const stacks = snap.rows.reduce<Record<string, number>>((m, r) => { const k = r.ma?.stack ?? "error"; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const reversals = snap.rows.reduce<Record<string, number>>((m, r) => { const k = r.reversal?.signal ?? "none"; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return { jsonBody: { status: "ok", date: snap.date, count: snap.count, scored: snap.scored, failed: snap.failed, stacks, reversals } };
}

async function results(req: HttpRequest): Promise<HttpResponseInit> {
  const q = req.query.get("date");
  const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : "latest";
  const [row, all] = await Promise.all([
    getOne<StoredSnap>(TABLES.SWING_SCAN, date, "snapshot"),
    listAll<StoredSnap>(TABLES.SWING_SCAN),
  ]);
  const dates = [...new Set(all.map((r) => r.partitionKey).filter((k) => k !== "latest"))].sort();
  const snap = inflate(row);
  if (!snap) return { status: 404, jsonBody: { error: date === "latest" ? "not scored yet — run the scan" : `no scan stored for ${date}`, dates } };
  return { jsonBody: { ...snap, dates }, headers: { "Cache-Control": "no-store" } };
}

app.http("swingScan", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "swing-scan",
  handler: async (req, ctx) => {
    try { return await scan(req, ctx); }
    catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      ctx.error(`swing-scan error: ${message}`);
      return { status: 500, jsonBody: { error: message } };
    }
  },
});

app.http("swingResults", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "swing-results",
  handler: async (req, ctx) => {
    try { return await results(req); }
    catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      ctx.error(`swing-results error: ${message}`);
      return { status: 500, jsonBody: { error: message } };
    }
  },
});
