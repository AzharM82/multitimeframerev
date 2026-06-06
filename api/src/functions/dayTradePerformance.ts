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

// Per-alert simulated result, keyed by rowKey so the alerts table can show
// realized (exit-rule) P&L instead of a misleading hold-forever live mark.
interface TradeResult {
  rowKey: string;
  result: "TP" | "SL" | "EOD" | "SKIP_WINDOW" | "SKIP_CAP" | "NO_DATA";
  exitPx?: number;
  sl?: number;
  pnl?: number;
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
const TARGET_PCT = 0.03;   // +3% take-profit
// SL rule: low of the previous 2 5-min bars before firedAt
// (= last 10 1-min bars whose ts < firedAt). Static — set at entry,
// not trailing. Fallback to entry * (1 - SL_PCT_FALLBACK) only if no
// pre-fire bars exist (alert at session start).
const SL_PCT_FALLBACK = 0.02;
const SL_PREV_1MIN_BARS = 10;

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

// In-process cache for the per-day backtest result, keyed by mode.
// Survives across requests in the same Function instance; invalidated
// on cold start. 5-min TTL keeps it from drifting too far from live
// data when new alerts land.
const cachedByMode = new Map<string, { at: number; payload: ResponseShape }>();
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
  mode: "tp_sl" | "sl_only";
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
  trades: TradeResult[];
}

async function fetch1mBars(ticker: string, date: string, apiKey: string): Promise<Bar[]> {
  const key = `${ticker}|${date}`;
  const hit = barCache.get(key);
  if (hit && hit.length > 0) return hit;   // only serve non-empty cache hits

  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    // Don't cache failures — let the next call retry. Rate-limits and
    // partial-data windows would otherwise pin us to $0 P&L for the day.
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
  if (bars.length > 0) barCache.set(key, bars);   // only cache non-empty
  return bars;
}

function computeSl(entry: number, bars: Bar[], firedAtMs: number): number {
  // Low of the last SL_PREV_1MIN_BARS 1-min bars before firedAt
  // (= 2 5-min bars on the scanner's chart timeframe).
  const pre: Bar[] = [];
  for (const b of bars) {
    if (b.ts < firedAtMs) pre.push(b);
    else break;
  }
  const window = pre.slice(-SL_PREV_1MIN_BARS);
  if (window.length === 0) return entry * (1 - SL_PCT_FALLBACK);
  let lo = window[0].low;
  for (const b of window) if (b.low < lo) lo = b.low;
  return lo;
}

function simulateExit(entry: number, bars: Bar[], firedAtMs: number): { exitPx: number; reason: "TP" | "SL" | "EOD"; sl: number } {
  const tp = entry * (1 + TARGET_PCT);
  const sl = computeSl(entry, bars, firedAtMs);
  let last: Bar | null = null;
  for (const b of bars) {
    if (b.ts < firedAtMs) continue;
    last = b;
    if (b.low <= sl)  return { exitPx: sl, reason: "SL", sl };
    if (b.high >= tp) return { exitPx: tp, reason: "TP", sl };
  }
  if (!last) return { exitPx: entry, reason: "EOD", sl };
  return { exitPx: last.close, reason: "EOD", sl };
}

/**
 * Mode "sl_only": no TP, trailing SL = min low of last SL_PREV_1MIN_BARS
 * bars ending at each post-fire bar. SL only ratchets UP (never down).
 * Trade exits when current bar's low ≤ trailing SL, else EOD close.
 */
function simulateExitTrailingSlOnly(entry: number, bars: Bar[], firedAtMs: number): { exitPx: number; reason: "SL" | "EOD"; sl: number } {
  let sl = computeSl(entry, bars, firedAtMs);
  let last: Bar | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.ts < firedAtMs) continue;
    last = b;
    // Candidate trailing SL: min low of last SL_PREV_1MIN_BARS bars
    // ending at (but not including) the current bar.
    const wStart = Math.max(0, i - SL_PREV_1MIN_BARS);
    let cand = Infinity;
    for (let j = wStart; j < i; j++) {
      if (bars[j].low < cand) cand = bars[j].low;
    }
    if (Number.isFinite(cand) && cand > sl) sl = cand;   // ratchet only up
    if (b.low <= sl) return { exitPx: sl, reason: "SL", sl };
  }
  if (!last) return { exitPx: entry, reason: "EOD", sl };
  return { exitPx: last.close, reason: "EOD", sl };
}

function dateOf(firedAt: string): string {
  return firedAt.slice(0, 10);
}

async function dayTradePerfHandler(req: HttpRequest): Promise<HttpResponseInit> {
  // ?mode=sl_only  →  trailing SL, no TP. Default "tp_sl" uses +3% TP +
  // static prev-2-5m-low SL.
  const mode = (req.query.get("mode") || "tp_sl").toLowerCase() === "sl_only" ? "sl_only" : "tp_sl";
  // ?fresh=1 bypasses both the result cache AND the per-bar cache so a
  // partial Polygon response can't pin us to stale $0 P&L days.
  const fresh = req.query.get("fresh") === "1";

  const cacheKey = mode;
  if (!fresh) {
    const hit = cachedByMode.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { jsonBody: hit.payload };
    }
  } else {
    barCache.clear();
    cachedByMode.clear();
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
  const trades: TradeResult[] = [];
  let skippedFilter = 0;
  let skippedCap = 0;

  for (const a of alerts) {
    const entry = Number(a.reversalPrice);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const date = dateOf(a.firedAt);
    const firedMs = new Date(a.firedAt).getTime();
    if (!Number.isFinite(firedMs)) continue;

    // Trade-window filter: skip first 40m / last 15m of RTH.
    if (!isAllowed(etMinutes(a.firedAt))) {
      skippedFilter++;
      trades.push({ rowKey: a.rowKey, result: "SKIP_WINDOW" });
      continue;
    }

    // Per-day cap: first MAX_PER_DAY only.
    const takenSoFar = countTakenByDay.get(date) ?? 0;
    if (takenSoFar >= MAX_PER_DAY) {
      skippedCap++;
      trades.push({ rowKey: a.rowKey, result: "SKIP_CAP" });
      continue;
    }

    const bars = await fetch1mBars(a.ticker, date, apiKey);
    if (bars.length === 0) {
      trades.push({ rowKey: a.rowKey, result: "NO_DATA" });
      continue;   // no Polygon data — skip silently
    }

    const { exitPx, reason, sl } = mode === "sl_only"
      ? simulateExitTrailingSlOnly(entry, bars, firedMs)
      : simulateExit(entry, bars, firedMs);
    const pnl = (exitPx - entry) / entry * NOTIONAL;
    trades.push({ rowKey: a.rowKey, result: reason, exitPx: round2(exitPx), sl: round2(sl), pnl: round2(pnl) });

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
    mode,
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
    trades,
  };

  cachedByMode.set(cacheKey, { at: Date.now(), payload });
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
