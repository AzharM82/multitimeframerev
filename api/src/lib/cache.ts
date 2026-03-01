import type { StockScanResult } from "./indicators.js";

interface CacheEntry {
  data: StockScanResult[];
  timestamp: number;
}

const TTL_MS = 15_000; // 15 seconds
let cached: CacheEntry | null = null;

export function getCachedScan(): StockScanResult[] | null {
  if (!cached) return null;
  if (Date.now() - cached.timestamp > TTL_MS) {
    cached = null;
    return null;
  }
  return cached.data;
}

export function setCachedScan(data: StockScanResult[]): void {
  cached = { data, timestamp: Date.now() };
}

export function clearCache(): void {
  cached = null;
}
