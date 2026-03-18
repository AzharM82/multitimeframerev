import type { Watchlist, WatchlistEntry, ScanResponse, ScanStatus, PhaseScanResponse, CapitulationScanResponse, WeeklyCapScanResponse } from "../types.js";

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

export function getWatchlist(): Promise<Watchlist> {
  return request<Watchlist>("/watchlist");
}

export function addTickers(tickers: WatchlistEntry[], replace = false): Promise<Watchlist> {
  return request<Watchlist>("/watchlist", {
    method: "POST",
    body: JSON.stringify({ tickers, replace }),
  });
}

export function removeTicker(ticker: string): Promise<Watchlist> {
  return request<Watchlist>(`/watchlist?ticker=${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

export function runScan(): Promise<ScanResponse> {
  return request<ScanResponse>("/scan");
}

export function getScanStatus(): Promise<ScanStatus> {
  return request<ScanStatus>("/scan-status");
}

// ─── Phase Oscillator API ────────────────────────────────────────────────────

export function getPhaseWatchlist(): Promise<Watchlist> {
  return request<Watchlist>("/phase-watchlist");
}

export function addPhaseTickers(tickers: WatchlistEntry[], replace = false): Promise<Watchlist> {
  return request<Watchlist>("/phase-watchlist", {
    method: "POST",
    body: JSON.stringify({ tickers, replace }),
  });
}

export function removePhaseTicker(ticker: string): Promise<Watchlist> {
  return request<Watchlist>(`/phase-watchlist?ticker=${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

export function runPhaseScan(): Promise<PhaseScanResponse> {
  return request<PhaseScanResponse>("/phase-scan");
}

// ─── Capitulation Scanner API ───────────────────────────────────────────────

export function getCapitulationWatchlist(): Promise<Watchlist> {
  return request<Watchlist>("/capitulation-watchlist");
}

export function addCapitulationTickers(tickers: WatchlistEntry[], replace = false): Promise<Watchlist> {
  return request<Watchlist>("/capitulation-watchlist", {
    method: "POST",
    body: JSON.stringify({ tickers, replace }),
  });
}

export function removeCapitulationTicker(ticker: string): Promise<Watchlist> {
  return request<Watchlist>(`/capitulation-watchlist?ticker=${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

export function runCapitulationScan(): Promise<CapitulationScanResponse> {
  return request<CapitulationScanResponse>("/capitulation-scan");
}

// ─── Weekly Capitulation Scanner API ────────────────────────────────────────

export function runWeeklyCapitulationScan(): Promise<WeeklyCapScanResponse> {
  return request<WeeklyCapScanResponse>("/weekly-capitulation-scan");
}
