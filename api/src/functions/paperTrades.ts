import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, listAll, TABLES } from "../lib/tables.js";

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

function buildOpenFromBull(rows: BullListRow[]): OpenTrade[] {
  return rows.map((r) => ({
    ticker: r.ticker,
    source: "bull" as const,
    entry: r.entry,
    sl: r.sl,
    tp: r.tp,
    qty: Math.floor(NOTIONAL_PER_TRADE / r.entry),
    openedAt: r.addedAt,
  }));
}

function aggregate(closed: ClosedTrade[]) {
  if (closed.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
      bestPct: 0,
      worstPct: 0,
      bySource: {} as Record<string, { count: number; wins: number; pnl: number }>,
    };
  }
  const wins = closed.filter((t) => t.pnlDollars > 0).length;
  const losses = closed.filter((t) => t.pnlDollars <= 0).length;
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
    winRate: Math.round((wins / closed.length) * 1000) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / closed.length) * 100) / 100,
    bestPct: Math.round(bestPct * 100) / 100,
    worstPct: Math.round(worstPct * 100) / 100,
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

    const closedTrades = buildClosedFromBull(closedBull);
    const openTrades = buildOpenFromBull(openBull);
    const stats = aggregate(closedTrades);

    if (view === "open") return { jsonBody: { open: openTrades } };
    if (view === "closed") return { jsonBody: { closed: closedTrades, stats } };
    if (view === "alerts") return { jsonBody: { alerts: allAlerts } };

    return {
      jsonBody: {
        stats,
        open: openTrades,
        closed: closedTrades.slice(-50).reverse(),
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
