import type {
  AvwapResultsResponse,
  BullListResponse,
  AtrScanResponse,
  AtrLookupResponse,
  AtrIntradayResponse,
  BreadthResponse,
} from "../types.js";

const BASE = "/api";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Section 1: AVWAP ───────────────────────────────────────────────────────

export function getAvwapResults(date?: string): Promise<AvwapResultsResponse> {
  return request<AvwapResultsResponse>(`/avwap-results${date ? `?date=${date}` : ""}`);
}

// ─── Section 2: Bull List ──────────────────────────────────────────────────

export function getBullList(status: "pending" | "open" | "closed" = "open"): Promise<BullListResponse> {
  return request<BullListResponse>(`/bull-list?status=${status}`);
}

export function deleteBullEntry(partition: string, rowKey: string): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/bull-list?partition=${partition}&rowKey=${encodeURIComponent(rowKey)}`,
    { method: "DELETE" },
  );
}

// ─── ATR Matrix ─────────────────────────────────────────────────────────────

export function getAtrScan(): Promise<AtrScanResponse> {
  return request<AtrScanResponse>("/atr-scan");
}

export function getBreadth(): Promise<BreadthResponse> {
  return request<BreadthResponse>("/breadth");
}

export function getAtrLookup(ticker: string): Promise<AtrLookupResponse> {
  return request<AtrLookupResponse>(`/atr-lookup?ticker=${encodeURIComponent(ticker.toUpperCase())}`);
}

export function getAtrIntraday(tickers: string[]): Promise<AtrIntradayResponse> {
  return request<AtrIntradayResponse>(`/atr-intraday?tickers=${encodeURIComponent(tickers.join(","))}`);
}

// ─── Day Trade Alerts (lightweight feed for the Day Trades page) ──────────
// Returns the alert table directly, enriched server-side with currentPrice
// via Polygon snapshot. The DayTradePage uses this instead of the heavier
// /paper-trades response.
import type { DayTradeAlertRow } from "../types.js";

export interface DayTradeAlertsResponse {
  total: number;
  recent: DayTradeAlertRow[];
}

export function getDayTradeAlerts(limit = 100): Promise<DayTradeAlertsResponse> {
  return request<DayTradeAlertsResponse>(`/day-trade-alerts?limit=${limit}`);
}

// ─── Day Trade Performance (daily realized P&L with TP/SL exits) ──────────

export interface DayPerfBucket {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export type PerfMode = "tp_sl" | "sl_only";

// Per-alert simulated result, keyed by AlertLog rowKey. The alerts table
// joins on this to show realized (exit-rule) P&L per alert.
export interface PerTradeResult {
  rowKey: string;
  result: "TP" | "SL" | "EOD" | "SKIP_WINDOW" | "SKIP_CAP" | "NO_DATA";
  exitPx?: number;
  sl?: number;
  pnl?: number;
}

export interface DayTradePerformanceResponse {
  mode: PerfMode;
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
    skippedFilter: number;
    skippedCap: number;
  };
  filters: {
    firstSkipMin: number;
    lastSkipMin: number;
    maxPerDay: number;
  };
  days: DayPerfBucket[];
  trades?: PerTradeResult[];
}

export function getDayTradePerformance(mode: PerfMode = "tp_sl"): Promise<DayTradePerformanceResponse> {
  return request<DayTradePerformanceResponse>(`/day-trade-performance?mode=${mode}`);
}
