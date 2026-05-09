import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, listAll, TABLES } from "../lib/tables.js";
import { fetchAllSnapshots, type SnapshotTicker } from "../lib/polygonSnapshot.js";

const NOTIONAL_PER_TRADE = 5000;

interface BullListRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  entry: number;
  sl: number;
  tp: number;
  status: "OPEN" | "TP_HIT" | "SL_HIT" | "EXPIRED";
  addedAt: string;
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  source: string;
}

interface AlertLogRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
}

interface ClosedTrade {
  ticker: string;
  source: "bull" | "daytrade" | "avwap";
  entry: number;
  exit: number;
  qty: number;
  pnlDollars: number;
  pnlPct: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
}

interface OpenTrade {
  ticker: string;
  source: "bull";
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  openedAt: string;
  last: number | null;
  unrealizedDollars: number | null;
  unrealizedPct: number | null;
}

function pickPrice(s: SnapshotTicker | undefined): number | null {
  if (!s) return null;
  return s.min?.c || s.lastTrade?.p || s.day?.c || s.prevDay?.c || null;
}

function buildClosedFromBull(rows: BullListRow[]): ClosedTrade[] {
  return rows
    .filter((r) => r.exitPrice !== undefined && r.closedAt)
    .map((r) => {
      const qty = Math.floor(NOTIONAL_PER_TRADE / r.entry);
      const exit = r.exitPrice as number;
      const pnlDollars = (exit - r.entry) * qty;
      const pnlPct = ((exit - r.entry) / r.entry) * 100;
      return {
        ticker: r.ticker,
        source: "bull" as const,
        entry: r.entry,
        exit,
        qty,
        pnlDollars: Math.round(pnlDollars * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        exitReason: r.exitReason ?? r.status,
        openedAt: r.addedAt,
        closedAt: r.closedAt as string,
      };
    });
}

function buildOpenFromBull(rows: BullListRow[], snapshots: Map<string, SnapshotTicker>): OpenTrade[] {
  return rows.map((r) => {
    const qty = Math.floor(NOTIONAL_PER_TRADE / r.entry);
    const last = pickPrice(snapshots.get(r.ticker));
    const unrealizedDollars = last !== null ? Math.round((last - r.entry) * qty * 100) / 100 : null;
    const unrealizedPct = last !== null ? Math.round(((last - r.entry) / r.entry) * 10000) / 100 : null;
    return {
      ticker: r.ticker,
      source: "bull" as const,
      entry: r.entry,
      sl: r.sl,
      tp: r.tp,
      qty,
      openedAt: r.addedAt,
      last,
      unrealizedDollars,
      unrealizedPct,
    };
  });
}

function aggregate(closed: ClosedTrade[], open: OpenTrade[]) {
  const openPnl = open.reduce((s, t) => s + (t.unrealizedDollars ?? 0), 0);
  const openMarked = open.filter((t) => t.unrealizedDollars !== null).length;

  if (closed.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
      bestPct: 0,
      worstPct: 0,
      openPnl: Math.round(openPnl * 100) / 100,
      openCount: open.length,
      openMarked,
      bySource: {} as Record<string, { count: number; wins: number; pnl: number }>,
    };
  }
  const wins = closed.filter((t) => t.pnlDollars > 0).length;
  const losses = closed.filter((t) => t.pnlDollars < 0).length;
  const breakevens = closed.filter((t) => t.pnlDollars === 0).length;
  const decisive = wins + losses;
  const totalPnl = closed.reduce((s, t) => s + t.pnlDollars, 0);
  const bestPct = Math.max(...closed.map((t) => t.pnlPct));
  const worstPct = Math.min(...closed.map((t) => t.pnlPct));

  const bySource: Record<string, { count: number; wins: number; pnl: number }> = {};
  for (const t of closed) {
    const s = (bySource[t.source] ||= { count: 0, wins: 0, pnl: 0 });
    s.count++;
    if (t.pnlDollars > 0) s.wins++;
    s.pnl += t.pnlDollars;
  }
  for (const k of Object.keys(bySource)) {
    bySource[k].pnl = Math.round(bySource[k].pnl * 100) / 100;
  }

  return {
    totalTrades: closed.length,
    wins,
    losses,
    breakevens,
    winRate: decisive > 0 ? Math.round((wins / decisive) * 1000) / 10 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / closed.length) * 100) / 100,
    bestPct: Math.round(bestPct * 100) / 100,
    worstPct: Math.round(worstPct * 100) / 100,
    openPnl: Math.round(openPnl * 100) / 100,
    openCount: open.length,
    openMarked,
    bySource,
  };
}

async function paperTradesHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const view = (req.query.get("view") ?? "summary").toLowerCase();

  try {
    const [openBull, closedBull, allAlerts] = await Promise.all([
      listByPartition<BullListRow>(TABLES.BULL_LIST, "open"),
      listByPartition<BullListRow>(TABLES.BULL_LIST, "closed"),
      listAll<AlertLogRow>(TABLES.ALERT_LOG).catch(() => [] as AlertLogRow[]),
    ]);

    const tickers = Array.from(new Set(openBull.map((r) => r.ticker)));
    const snapshots = tickers.length > 0
      ? await fetchAllSnapshots(tickers).catch(() => new Map<string, SnapshotTicker>())
      : new Map<string, SnapshotTicker>();

    const closedTrades = buildClosedFromBull(closedBull);
    closedTrades.sort((a, b) => b.closedAt.localeCompare(a.closedAt));

    const openTrades = buildOpenFromBull(openBull, snapshots);
    openTrades.sort((a, b) => b.openedAt.localeCompare(a.openedAt));

    const stats = aggregate(closedTrades, openTrades);

    if (view === "open") return { jsonBody: { open: openTrades } };
    if (view === "closed") return { jsonBody: { closed: closedTrades, stats } };
    if (view === "alerts") return { jsonBody: { alerts: allAlerts } };

    return {
      jsonBody: {
        stats,
        open: openTrades,
        closed: closedTrades.slice(0, 50),
        dayTradeAlerts: {
          total: allAlerts.length,
          recent: allAlerts.slice(-25).reverse(),
        },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("paperTrades", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "paper-trades",
  handler: paperTradesHandler,
});
