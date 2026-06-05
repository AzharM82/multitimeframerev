import type {
  AvwapResultsResponse,
  BullListResponse,
  AtrScanResponse,
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

export function getBullList(status: "open" | "closed" = "open"): Promise<BullListResponse> {
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
}

export function getDayTradePerformance(mode: PerfMode = "tp_sl"): Promise<DayTradePerformanceResponse> {
  return request<DayTradePerformanceResponse>(`/day-trade-performance?mode=${mode}`);
}
