import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, listByPartition, TABLES } from "../lib/tables.js";

/**
 * Journal — the trade side.
 *
 *   POST /api/journal-trades   (x-timer-secret)  push fills
 *   GET  /api/journal-trades?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The portal does NOT talk to SnapTrade or to the standalone journal app. A
 * scheduled job on the trading desktop (tools/journal-sync) pulls the fills and
 * pushes them here, so the SnapTrade credentials and the other app's password
 * never exist in Azure. See that tool's README for the whole flow.
 *
 * Fills are keyed by trade date so a day reads as one partition, and by the
 * source fill id so a re-push is an upsert rather than a duplicate — the sync
 * job re-sends a trailing window every run.
 */

/** Journal history starts here (user decision 2026-08-08). */
const EPOCH = "2026-08-03";

interface FillRow {
  rowKey: string;
  ticker?: string;
  underlying?: string;
  assetType?: string;
  side?: string;
  quantity?: number;
  price?: number;
  fees?: number;
  realizedPnl?: number | null;
  carriedQty?: number;
  openedOn?: string | null;
  groupOpenQty?: number;
  filledAt?: string;
  broker?: string;
}

interface IncomingFill {
  id: string;
  trade_date: string;
  ticker: string;
  underlying: string;
  asset_type: string;
  side: string;
  quantity: number;
  price: number;
  fees?: number;
  realized_pnl?: number | null;
  /** Of a closing fill, how many contracts came from a lot opened earlier. */
  carried_qty?: number;
  /** The earliest day those carried contracts were opened. */
  opened_on?: string | null;
  /** This (day, symbol) group's qty still open at that day's close. */
  group_open_qty?: number;
  filled_at?: string;
  broker: string;
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Every ET trading date from `from` to `to`, inclusive. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function push(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const body = (await req.json()) as { fills?: IncomingFill[] };
  const fills = body.fills ?? [];
  if (!Array.isArray(fills)) {
    return { status: 400, jsonBody: { error: "fills must be an array" } };
  }

  let written = 0;
  let skipped = 0;
  for (const f of fills) {
    // Defence in depth: the sync job already filters, but the epoch is a
    // product decision and belongs on the server too.
    if (!f?.id || !isDate(f.trade_date ?? "") || f.trade_date < EPOCH) {
      skipped += 1;
      continue;
    }
    await upsert(TABLES.JOURNAL_FILLS, f.trade_date, f.id.replace(/[/\\#?]/g, "_"), {
      ticker: f.ticker,
      underlying: f.underlying,
      assetType: f.asset_type,
      side: f.side,
      quantity: f.quantity,
      price: f.price,
      fees: f.fees ?? 0,
      // Only closing fills carry realized P&L; opens are legitimately null.
      realizedPnl: f.realized_pnl ?? null,
      carriedQty: f.carried_qty ?? 0,
      openedOn: f.opened_on ?? null,
      groupOpenQty: f.group_open_qty ?? 0,
      filledAt: f.filled_at ?? "",
      broker: f.broker,
    });
    written += 1;
  }

  return { jsonBody: { status: "ok", written, skipped } };
}

async function read(req: HttpRequest): Promise<HttpResponseInit> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const rawFrom = (req.query.get("from") || "").trim();
  const rawTo = (req.query.get("to") || "").trim();
  const from = isDate(rawFrom) && rawFrom > EPOCH ? rawFrom : EPOCH;
  const to = isDate(rawTo) ? rawTo : today;

  const fills: Array<Record<string, unknown>> = [];
  for (const date of dateRange(from, to)) {
    const rows = await listByPartition<FillRow>(TABLES.JOURNAL_FILLS, date);
    for (const r of rows) {
      fills.push({
        id: r.rowKey,
        tradeDate: date,
        ticker: r.ticker,
        underlying: r.underlying,
        assetType: r.assetType,
        side: r.side,
        quantity: r.quantity,
        price: r.price,
        fees: r.fees,
        realizedPnl: r.realizedPnl ?? null,
        // Rows written before these existed read back as the neutral case:
        // nothing carried, nothing left open.
        carriedQty: r.carriedQty ?? 0,
        openedOn: r.openedOn ?? null,
        groupOpenQty: r.groupOpenQty ?? 0,
        filledAt: r.filledAt,
        broker: r.broker,
      });
    }
  }

  return { jsonBody: { from, to, epoch: EPOCH, count: fills.length, fills } };
}

async function journalTrades(req: HttpRequest): Promise<HttpResponseInit> {
  try {
    return req.method === "POST" ? await push(req) : await read(req);
  } catch (err) {
    return { status: 500, jsonBody: { error: err instanceof Error ? err.message : "Unknown error" } };
  }
}

app.http("journalTrades", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "journal-trades",
  handler: journalTrades,
});
