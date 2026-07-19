// Ported from ShouldIBeTrading (api/src/lib/polygon.ts).
// NOTE: this Polygon plan has NO real-time entitlement — last-trade / quote
// endpoints return NOT_AUTHORIZED. Only aggregate and snapshot endpoints are
// used here, and every index fetcher degrades to null/empty rather than
// throwing, so macroQuotes.ts can fall back cleanly.

import type { Candle, SnapshotTicker } from "./types.js";
import { daysAgo, today } from "./marketHours.js";

const BASE_URL = "https://api.polygon.io";

function getApiKey(): string {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error("POLYGON_API_KEY not set");
  return key;
}

// ─── Snapshot API ─────────────────────────────────────────────

export async function fetchSnapshot(tickers: string[]): Promise<Map<string, SnapshotTicker>> {
  const tickerStr = tickers.join(",");
  const url = `${BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerStr}&apiKey=${getApiKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polygon snapshot error ${res.status}: ${text}`);
  }

  const data = await res.json() as { tickers?: SnapshotTicker[] };
  const map = new Map<string, SnapshotTicker>();
  if (data.tickers) {
    for (const t of data.tickers) {
      map.set(t.ticker, t);
    }
  }
  return map;
}

// ─── Aggregates API ───────────────────────────────────────────

interface PolygonAggResult {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: number;
}

interface PolygonAggResponse {
  results?: PolygonAggResult[];
  resultsCount?: number;
}

function toCandles(data: PolygonAggResponse): Candle[] {
  if (!data.results || data.results.length === 0) return [];
  return data.results.map((r) => ({
    o: r.o,
    h: r.h,
    l: r.l,
    c: r.c,
    v: r.v,
    t: r.t,
  }));
}

export async function fetchDailyBars(ticker: string, days: number): Promise<Candle[]> {
  const from = daysAgo(Math.ceil(days * 1.5)); // extra for weekends/holidays
  const to = today();
  const url = `${BASE_URL}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${getApiKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polygon aggs error for ${ticker} ${res.status}: ${text}`);
  }

  return toCandles(await res.json() as PolygonAggResponse);
}

// ─── Index Ticker Aggregates (for VIX, DXY, TNX) ─────────────

export async function fetchIndexDailyBars(ticker: string, days: number): Promise<Candle[]> {
  const from = daysAgo(Math.ceil(days * 1.5));
  const to = today();
  // Index tickers use the same aggs endpoint
  const encodedTicker = encodeURIComponent(ticker);
  const url = `${BASE_URL}/v2/aggs/ticker/${encodedTicker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${getApiKey()}`;

  try {
    const res = await fetch(url);
    // Fallback: return empty, caller should use fallback source
    if (!res.ok) return [];
    return toCandles(await res.json() as PolygonAggResponse);
  } catch {
    return [];
  }
}

// ─── VIX Snapshot (uses indices snapshot) ─────────────────────

export async function fetchVixSnapshot(): Promise<{ level: number; change: number } | null> {
  // VIX is an index — try the indices snapshot endpoint
  const url = `${BASE_URL}/v3/snapshot/indices?ticker.any_of=I:VIX&apiKey=${getApiKey()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json() as {
      results?: Array<{
        value?: number;
        ticker?: string;
        session?: { change?: number; previous_close?: number; close?: number };
      }>;
    };

    if (!data.results || data.results.length === 0) return null;

    const vix = data.results[0];
    const level = vix.value ?? vix.session?.close ?? 0;
    const change = vix.session?.change ?? 0;

    return { level, change };
  } catch {
    return null;
  }
}

// ─── Index Snapshot (TNX, DXY) ───────────────────────────────

export async function fetchIndexSnapshot(tickers: string[]): Promise<Map<string, { value: number; change: number }>> {
  const tickerStr = tickers.join(",");
  const url = `${BASE_URL}/v3/snapshot/indices?ticker.any_of=${encodeURIComponent(tickerStr)}&apiKey=${getApiKey()}`;

  const map = new Map<string, { value: number; change: number }>();
  try {
    const res = await fetch(url);
    if (!res.ok) return map;

    const data = await res.json() as {
      results?: Array<{
        ticker?: string;
        value?: number;
        session?: { change?: number; close?: number };
      }>;
    };

    if (data.results) {
      for (const r of data.results) {
        if (r.ticker) {
          map.set(r.ticker, {
            value: r.value ?? r.session?.close ?? 0,
            change: r.session?.change ?? 0,
          });
        }
      }
    }
  } catch {
    // degrade to empty map
  }
  return map;
}
