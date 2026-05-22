import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listAll, TABLES } from "../lib/tables.js";

/**
 * GET /api/day-trade-performance
 *
 * Replays every alert in ALERT_LOG through a TP/SL/EOD simulator on
 * 1-min Polygon bars and returns the daily-aggregated $1k paper-trade
 * P&L plus headline stats.
 *
 * Exit rule (matches autoresearch/evaluate.py):
 *   entry = reversalPrice
 *   exit at FIRST crossing of either:
 *     - TP   = entry × 1.03           (default +3% target)
 *     - SL   = alert.sl if present, else entry × 0.98 (2% fallback)
 *   else EOD = last 1m close of the trading day
 *
 * Response:
 *   {
 *     stats: { totalPnl, totalTrades, wins, losses, winRate, bestDay, worstDay, avgPerTrade },
 *     days:  [{ date, pnl, trades, wins, losses }]   (chronological)
 *   }
 *
 * Heavy lift on a cold instance — first request can take ~5-10 sec while
 * Polygon 1-min aggs are fetched per (ticker, date). Subsequent requests
 * within the same Function instance use the in-process cache.
 */

interface AlertLogRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  sl?: number;
}

interface Bar {
  ts: number;        // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PolygonAggResponse {
  results?: { t: number; o: number; h: number; l: number; c: number }[];
  resultsCount?: number;
}

const NOTIONAL = 1000;
const TARGET_PCT = 0.05;   // +5% take-profit (was 0.03)
const DEFAULT_SL_PCT_FALLBACK = 0.02;

// Trade-window filters. Skip alerts fired in the first FIRST_SKIP_MIN
// minutes after RTH open (9:30 ET) or in the last LAST_SKIP_MIN minutes
// before the close (16:00 ET). After filters, take only the first
// MAX_PER_DAY alerts chronologically per trading date.
const FIRST_SKIP_MIN = 40;
const LAST_SKIP_MIN  = 15;
const MAX_PER_DAY    = 10;
const RTH_OPEN_ET_MIN  = 9 * 60 + 30;   // 570
const RTH_CLOSE_ET_MIN = 16 * 60;       // 960

// Returns minutes-since-midnight in America/New_York for the given ISO ts.
// Handles DST automatically via toLocaleString.
function etMinutes(iso: string): number {
  const hhmm = new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
  return h * 60 + m;
}

function isAllowed(etMin: number): boolean {
  if (etMin < RTH_OPEN_ET_MIN + FIRST_SKIP_MIN) return false;   // first 40m
  if (etMin >= RTH_CLOSE_ET_MIN - LAST_SKIP_MIN) return false;  // last 15m
  return true;
}

// In-process cache for the per-day backtest result. Survives across requests
// in the same Function instance; invalidated on cold start. 5-min TTL keeps
// it from drifting too far from live data when new alerts land.
let cached: { at: number; payload: ResponseShape } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Per-(ticker, date) 1-min bar cache. Historical bars don't change so we
// keep them in process forever once fetched.
const barCache = new Map<string, Bar[]>();

interface DayBucket {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

interface ResponseShape {
  stats: {
    totalPnl: number;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    bestDay: { date: string; pnl: number } | null;
    worstDay: { date: string; pnl: number } | null;
    avgPerTrade: number;
    daysCovered: number;
    skippedFilter: number;     // alerts dropped by time-of-day window
    skippedCap: number;        // alerts dropped by per-day cap
  };
  filters: {
    firstSkipMin: number;
    lastSkipMin: number;
    maxPerDay: number;
  };
  days: DayBucket[];
}

async function fetch1mBars(ticker: string, date: string, apiKey: string): Promise<Bar[]> {
  const key = `${ticker}|${date}`;
  const hit = barCache.get(key);
  if (hit) return hit;

  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    barCache.set(key, []);
    return [];
  }
  const data = (await res.json()) as PolygonAggResponse;
  const bars: Bar[] = (data.results ?? []).map((r) => ({
    ts: r.t,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
  }));
  barCache.set(key, bars);
  return bars;
}

function simulateExit(entry: number, sl: number, bars: Bar[], firedAtMs: number): { exitPx: number; reason: "TP" | "SL" | "EOD" } {
  const tp = entry * (1 + TARGET_PCT);
  // bars are chronological; walk from firedAt forward
  let last: Bar | null = null;
  for (const b of bars) {
    if (b.ts < firedAtMs) continue;
    last = b;
    if (b.low <= sl)  return { exitPx: sl, reason: "SL" };
    if (b.high >= tp) return { exitPx: tp, reason: "TP" };
  }
  if (!last) return { exitPx: entry, reason: "EOD" };
  return { exitPx: last.close, reason: "EOD" };
}

function dateOf(firedAt: string): string {
  return firedAt.slice(0, 10);
}

async function dayTradePerfHandler(_req: HttpRequest): Promise<HttpResponseInit> {
  // Serve cache if fresh
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { jsonBody: cached.payload };
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return { status: 500, jsonBody: { error: "POLYGON_API_KEY not set" } };

  let alerts: AlertLogRow[];
  try {
    alerts = await listAll<AlertLogRow>(TABLES.ALERT_LOG);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: `ALERT_LOG read failed: ${message}` } };
  }

  // Sort alerts chronologically so the per-day cap is deterministic.
  alerts.sort((a, b) => (a.firedAt ?? "").localeCompare(b.firedAt ?? ""));

  const byDay = new Map<string, DayBucket>();
  const countTakenByDay = new Map<string, number>();
  let skippedFilter = 0;
  let skippedCap = 0;

  for (const a of alerts) {
    const entry = Number(a.reversalPrice);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const date = dateOf(a.firedAt);
    const firedMs = new Date(a.firedAt).getTime();
    if (!Number.isFinite(firedMs)) continue;

    // Trade-window filter: skip first 40m / last 15m of RTH.
    if (!isAllowed(etMinutes(a.firedAt))) { skippedFilter++; continue; }

    // Per-day cap: first MAX_PER_DAY only.
    const takenSoFar = countTakenByDay.get(date) ?? 0;
    if (takenSoFar >= MAX_PER_DAY) { skippedCap++; continue; }

    const sl = (typeof a.sl === "number" && a.sl > 0) ? a.sl : entry * (1 - DEFAULT_SL_PCT_FALLBACK);

    const bars = await fetch1mBars(a.ticker, date, apiKey);
    if (bars.length === 0) continue;   // no Polygon data — skip silently

    const { exitPx } = simulateExit(entry, sl, bars, firedMs);
    const pnl = (exitPx - entry) / entry * NOTIONAL;

    let bucket = byDay.get(date);
    if (!bucket) {
      bucket = { date, pnl: 0, trades: 0, wins: 0, losses: 0 };
      byDay.set(date, bucket);
    }
    bucket.trades += 1;
    bucket.pnl += pnl;
    if (pnl > 0) bucket.wins += 1;
    else if (pnl < 0) bucket.losses += 1;
    countTakenByDay.set(date, takenSoFar + 1);
  }

  const days = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

  const totalPnl = days.reduce((s, d) => s + d.pnl, 0);
  const totalTrades = days.reduce((s, d) => s + d.trades, 0);
  const wins = days.reduce((s, d) => s + d.wins, 0);
  const losses = days.reduce((s, d) => s + d.losses, 0);
  const decisive = wins + losses;
  const winRate = decisive > 0 ? wins / decisive : 0;
  const avgPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const bestDay = days.length ? days.reduce((a, b) => (a.pnl >= b.pnl ? a : b)) : null;
  const worstDay = days.length ? days.reduce((a, b) => (a.pnl <= b.pnl ? a : b)) : null;

  const payload: ResponseShape = {
    stats: {
      totalPnl: round2(totalPnl),
      totalTrades,
      wins,
      losses,
      winRate: round4(winRate),
      bestDay: bestDay ? { date: bestDay.date, pnl: round2(bestDay.pnl) } : null,
      worstDay: worstDay ? { date: worstDay.date, pnl: round2(worstDay.pnl) } : null,
      avgPerTrade: round2(avgPerTrade),
      daysCovered: days.length,
      skippedFilter,
      skippedCap,
    },
    filters: {
      firstSkipMin: FIRST_SKIP_MIN,
      lastSkipMin:  LAST_SKIP_MIN,
      maxPerDay:    MAX_PER_DAY,
    },
    days: days.map((d) => ({ ...d, pnl: round2(d.pnl) })),
  };

  cached = { at: Date.now(), payload };
  return { jsonBody: payload };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

app.http("dayTradePerformance", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "day-trade-performance",
  handler: dayTradePerfHandler,
});
