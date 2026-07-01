import type {
  AvwapResultsResponse,
  BullListResponse,
  AtrScanResponse,
  AtrLookupResponse,
  AtrIntradayResponse,
  BreadthResponse,
  CveScanResponse,
  BigdogAlertsResponse,
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

// ─── Catalyst Value Eval ────────────────────────────────────────────────────

export function getCveScan(): Promise<CveScanResponse> {
  return request<CveScanResponse>("/cve-scan");
}

// ─── BIGD-Intraday ──────────────────────────────────────────────────────────

export function getBigdogAlerts(date?: string): Promise<BigdogAlertsResponse> {
  return request<BigdogAlertsResponse>(`/bigdog-alerts${date ? `?date=${date}` : ""}`);
}

// Day Trades section removed (2026-06-16) — superseded by DTSWAI (real Alpaca
// paper). The local scanner still posts to /api/scanner-alert + sends WhatsApp;
// only the website surface was retired.
