import type { Watchlist, ScanResponse, ScanStatus } from "../types.js";

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

export function addTickers(tickers: string[], replace = false): Promise<Watchlist> {
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
