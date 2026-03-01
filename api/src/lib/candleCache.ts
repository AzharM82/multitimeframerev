import type { Candle } from "./indicators.js";

interface CacheEntry {
  candles: Candle[];
  fetchedAt: number;
}

// TTLs in milliseconds
const WEEKLY_TTL = 12 * 60 * 60_000; // 12 hours
const DAILY_TTL = 60 * 60_000;       // 1 hour

// Cache keyed by "TICKER:timeframe"
const cache = new Map<string, CacheEntry>();

function key(ticker: string, timeframe: string): string {
  return `${ticker}:${timeframe}`;
}

export function getCachedCandles(ticker: string, timeframe: "weekly" | "daily"): Candle[] | null {
  const entry = cache.get(key(ticker, timeframe));
  if (!entry) return null;

  const ttl = timeframe === "weekly" ? WEEKLY_TTL : DAILY_TTL;
  if (Date.now() - entry.fetchedAt > ttl) {
    cache.delete(key(ticker, timeframe));
    return null;
  }

  return entry.candles;
}

export function setCachedCandles(ticker: string, timeframe: "weekly" | "daily", candles: Candle[]): void {
  cache.set(key(ticker, timeframe), { candles, fetchedAt: Date.now() });
}

export function getCacheStats(): { size: number; tickers: string[] } {
  const tickers = new Set<string>();
  for (const k of cache.keys()) {
    tickers.add(k.split(":")[0]);
  }
  return { size: cache.size, tickers: [...tickers] };
}
