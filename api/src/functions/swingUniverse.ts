import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, listByPartition, remove, getOne, TABLES } from "../lib/tables.js";
import { parseFinvizExport, type UniverseRow } from "../lib/swing/universe.js";

/**
 * Swing Strength — the universe.
 *
 *   GET  /api/swing-universe          the current list + when it was last uploaded
 *   POST /api/swing-universe          body = a FinViz CSV export (text). REPLACES the list.
 *
 * The POST needs a signed-in portal session or the timer secret. Replacement
 * is whole-list on purpose: the operator curates the list in FinViz and pastes
 * the export; a merge would silently keep names they removed.
 */

const PART = "current";

function authorized(req: HttpRequest): boolean {
  const signedIn = !!req.headers.get("x-ms-client-principal");
  const viaSecret = !!process.env.TIMER_SECRET && req.headers.get("x-timer-secret") === process.env.TIMER_SECRET;
  return signedIn || viaSecret;
}

interface StoredRow extends Omit<UniverseRow, "extras"> {
  rowKey: string;
  extrasJson?: string;
  addedAt?: string;
}

export async function loadUniverse(): Promise<UniverseRow[]> {
  const rows = await listByPartition<StoredRow>(TABLES.SWING_UNIVERSE, PART);
  return rows
    .map((r) => ({
      ticker: r.ticker ?? r.rowKey, company: r.company ?? "", sector: r.sector ?? "", industry: r.industry ?? "",
      marketCapM: typeof r.marketCapM === "number" ? r.marketCapM : null,
      extras: safeJson(r.extrasJson),
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function safeJson(s: string | undefined): Record<string, number> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, number>; } catch { return {}; }
}

async function read(): Promise<HttpResponseInit> {
  const [rows, meta] = await Promise.all([
    loadUniverse(),
    getOne<{ updatedAt?: string; count?: number; columns?: string; skipped?: number }>(TABLES.SWING_UNIVERSE, "meta", "current"),
  ]);
  return {
    jsonBody: {
      count: rows.length,
      updatedAt: meta?.updatedAt ?? null,
      columns: meta?.columns ? safeList(meta.columns) : [],
      rows,
    },
    headers: { "Cache-Control": "no-store" },
  };
}

function safeList(s: string): string[] {
  try { return JSON.parse(s) as string[]; } catch { return []; }
}

async function replace(req: HttpRequest): Promise<HttpResponseInit> {
  if (!authorized(req)) return { status: 401, jsonBody: { error: "Unauthorized" } };
  const text = await req.text();
  if (!text || text.length > 2_000_000) return { status: 400, jsonBody: { error: "Send the FinViz CSV export as the request body" } };
  let parsed: ReturnType<typeof parseFinvizExport>;
  try { parsed = parseFinvizExport(text); }
  catch (err) { return { status: 400, jsonBody: { error: err instanceof Error ? err.message : "bad CSV" } }; }
  if (parsed.rows.length < 5) return { status: 400, jsonBody: { error: `Only ${parsed.rows.length} tickers parsed — refusing to replace the list` } };

  const now = new Date().toISOString();
  const existing = await listByPartition<StoredRow>(TABLES.SWING_UNIVERSE, PART);
  const keep = new Set(parsed.rows.map((r) => r.ticker));
  const addedAt = new Map(existing.map((r) => [r.rowKey, r.addedAt ?? now]));

  for (const r of parsed.rows) {
    await upsert(TABLES.SWING_UNIVERSE, PART, r.ticker, {
      ticker: r.ticker, company: r.company, sector: r.sector, industry: r.industry,
      marketCapM: r.marketCapM, extrasJson: JSON.stringify(r.extras), addedAt: addedAt.get(r.ticker) ?? now, updatedAt: now,
    });
  }
  let removed = 0;
  for (const r of existing) {
    if (!keep.has(r.rowKey)) { await remove(TABLES.SWING_UNIVERSE, PART, r.rowKey); removed++; }
  }
  await upsert(TABLES.SWING_UNIVERSE, "meta", "current", {
    updatedAt: now, count: parsed.rows.length, skipped: parsed.skipped, columns: JSON.stringify(parsed.columns),
  });
  return { jsonBody: { status: "ok", count: parsed.rows.length, added: parsed.rows.filter((r) => !addedAt.has(r.ticker)).length, removed, skipped: parsed.skipped, columns: parsed.columns } };
}

app.http("swingUniverse", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "swing-universe",
  handler: async (req, ctx) => {
    try { return req.method === "POST" ? await replace(req) : await read(); }
    catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      ctx.error(`swing-universe error: ${message}`);
      return { status: 500, jsonBody: { error: message } };
    }
  },
});
