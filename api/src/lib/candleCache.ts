import type { Candle } from "./indicators.js";
import Redis from "ioredis";

// ─── Redis client (lazy init) ────────────────────────────────────────────────

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;

  const connStr = process.env.REDIS_CONNECTION_STRING;
  if (!connStr) return null;

  // Azure Redis uses rediss:// (TLS on port 6380)
  redis = new Redis(connStr, {
    tls: connStr.startsWith("rediss://") ? {} : undefined,
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
  });
  redis.connect().catch(() => {
    redis = null;
  });
  return redis;
}

// ─── In-memory fallback when Redis is not configured ─────────────────────────

interface CacheEntry {
  candles: Candle[];
  fetchedAt: number;
}

const memCache = new Map<string, CacheEntry>();

// 24-hour TTL for both weekly and daily
const TTL_SECONDS = 24 * 60 * 60;
const TTL_MS = TTL_SECONDS * 1000;

function cacheKey(ticker: string, timeframe: string): string {
  return `candle:${ticker}:${timeframe}`;
}

export async function getCachedCandles(ticker: string, timeframe: "weekly" | "daily"): Promise<Candle[] | null> {
  const client = getRedis();
  const k = cacheKey(ticker, timeframe);

  if (client) {
    try {
      const raw = await client.get(k);
      if (!raw) return null;
      return JSON.parse(raw) as Candle[];
    } catch {
      // Redis error — fall through to memory
    }
  }

  // In-memory fallback
  const entry = memCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    memCache.delete(k);
    return null;
  }
  return entry.candles;
}

export async function setCachedCandles(ticker: string, timeframe: "weekly" | "daily", candles: Candle[]): Promise<void> {
  const client = getRedis();
  const k = cacheKey(ticker, timeframe);

  if (client) {
    try {
      await client.set(k, JSON.stringify(candles), "EX", TTL_SECONDS);
      return;
    } catch {
      // Redis error — fall through to memory
    }
  }

  // In-memory fallback
  memCache.set(k, { candles, fetchedAt: Date.now() });
}

export function getCacheStats(): { size: number; tickers: string[] } {
  const tickers = new Set<string>();
  for (const k of memCache.keys()) {
    const parts = k.split(":");
    if (parts.length >= 2) tickers.add(parts[1]);
  }
  return { size: memCache.size, tickers: [...tickers] };
}
