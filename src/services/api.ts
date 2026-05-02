import type {
  AvwapResultsResponse,
  BullListResponse,
  PaperTradesResponse,
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

// ─── Section 4: Performance ────────────────────────────────────────────────

export function getPaperTrades(): Promise<PaperTradesResponse> {
  return request<PaperTradesResponse>("/paper-trades");
}
