import type {
  MmPanelName,
  MmPanelResponse,
  GateScoreResponse,
  RotQuotesResponse,
  RotPerformanceResponse,
  RotWeeklyHistoryResponse,
  AtrScanResponse,
  AtrLookupResponse,
  AtrIntradayResponse,
  BreadthResponse,
  CveScanResponse,
  BigdogAlertsResponse,
  UoaScanResponse,
  UoaDatesResponse,
  TvAnalysisResponse,
  TvRequestResponse,
  TvHistoryResponse,
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

// ─── TradingView chart analysis ─────────────────────────────────────────────

/** Ask the desktop sidecar to analyse a ticker. Returns once queued, not done. */
export function requestTvAnalysis(ticker: string): Promise<TvRequestResponse> {
  return request<TvRequestResponse>("/tv-request", {
    method: "POST",
    body: JSON.stringify({ ticker: ticker.toUpperCase().trim() }),
  });
}

export function getTvAnalysis(ticker: string): Promise<TvAnalysisResponse> {
  return request<TvAnalysisResponse>(
    `/tv-analysis?ticker=${encodeURIComponent(ticker.toUpperCase().trim())}`,
  );
}

/** The day's per-bar net-score trend for one ticker. */
export function getTvHistory(ticker: string): Promise<TvHistoryResponse> {
  return request<TvHistoryResponse>(
    `/tv-history?ticker=${encodeURIComponent(ticker.toUpperCase().trim())}`,
  );
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

// ─── Unusual Options Activity ───────────────────────────────────────────────

export function getUoaSignals(date?: string): Promise<UoaScanResponse> {
  return request<UoaScanResponse>(`/uoa-signals${date ? `?date=${date}` : ""}`);
}

export function getUoaDates(): Promise<UoaDatesResponse> {
  return request<UoaDatesResponse>(`/uoa-signals?list=1`);
}

// ─── Rotation ───────────────────────────────────────────────────────────────

export function getRotQuotes(includeMeta = true): Promise<RotQuotesResponse> {
  return request<RotQuotesResponse>(`/rot-quotes${includeMeta ? "" : "?meta=0"}`);
}

export function getRotPerformance(period: "weekly" | "monthly" = "weekly"): Promise<RotPerformanceResponse> {
  return request<RotPerformanceResponse>(`/rot-performance?period=${period}`);
}

export function getRotWeeklyHistory(weeks = 4): Promise<RotWeeklyHistoryResponse> {
  return request<RotWeeklyHistoryResponse>(`/rot-weekly-history?weeks=${weeks}`);
}

// ─── Gate ───────────────────────────────────────────────────────────────────

export function getGateScore(mode: "day" | "swing" = "day"): Promise<GateScoreResponse> {
  return request<GateScoreResponse>(`/gate-score?mode=${mode}`);
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export function getMmPanel<T>(panel: MmPanelName): Promise<MmPanelResponse<T>> {
  return request<MmPanelResponse<T>>(`/mm-panel?panel=${panel}`);
}
