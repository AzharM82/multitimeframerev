import type { Candle } from "./indicators.js";
import { getCachedCandles, setCachedCandles } from "./candleCache.js";

const BASE_URL = "https://api.polygon.io";

function getApiKey(): string {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error("POLYGON_API_KEY not set");
  return key;
}

interface PolygonBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: number;
}

interface PolygonAggResponse {
  results?: PolygonBar[];
  resultsCount?: number;
  status?: string;
  error?: string;
}

function toCandles(bars: PolygonBar[]): Candle[] {
  return bars.map((b) => ({
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
    timestamp: b.t,
  }));
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function fetchAggs(
  ticker: string,
  multiplier: number,
  timespan: string,
  from: string,
  to: string,
): Promise<Candle[]> {
  const url = `${BASE_URL}/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${getApiKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polygon API error ${res.status}: ${text}`);
  }

  const data: PolygonAggResponse = await res.json() as PolygonAggResponse;
  if (!data.results || data.results.length === 0) {
    return [];
  }

  return toCandles(data.results);
}

// ─── Filter to regular market hours (9:30 AM – 4:00 PM ET) ──────────────────

function isRegularHours(timestampMs: number): boolean {
  const et = new Date(timestampMs).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  // et = "HH:MM"
  const [h, m] = et.split(":").map(Number);
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960; // 9:30 = 570, 16:00 = 960
}

function filterMarketHours(candles: Candle[]): Candle[] {
  return candles.filter((c) => isRegularHours(c.timestamp));
}

// ─── Individual timeframe fetchers ───────────────────────────────────────────

async function fetchWeeklyCandles(ticker: string): Promise<Candle[]> {
  const to = new Date();
  const from = new Date();
  // 3 years (~156 weeks) — EMA(21) needs 100+ bars to converge from seed value
  from.setDate(from.getDate() - 1095);
  return fetchAggs(ticker, 1, "week", formatDate(from), formatDate(to));
}

async function fetchDailyCandles(ticker: string): Promise<Candle[]> {
  const to = new Date();
  const from = new Date();
  // 2 years (~504 trading days) — EMA(21) needs sufficient history for convergence
  from.setDate(from.getDate() - 730);
  return fetchAggs(ticker, 1, "day", formatDate(from), formatDate(to));
}

async function fetch65mCandles(ticker: string): Promise<Candle[]> {
  const to = new Date();
  const from = new Date();
  // 45 calendar days (~30 trading days, ~180 bars) — find last reversal weeks back
  from.setDate(from.getDate() - 45);
  const candles = await fetchAggs(ticker, 65, "minute", formatDate(from), formatDate(to));
  return filterMarketHours(candles);
}

async function fetch10mCandles(ticker: string): Promise<Candle[]> {
  const to = new Date();
  const from = new Date();
  // 14 calendar days (~10 trading days, ~390 bars) — find last reversal days back
  from.setDate(from.getDate() - 14);
  const candles = await fetchAggs(ticker, 10, "minute", formatDate(from), formatDate(to));
  return filterMarketHours(candles);
}

// ─── Phase Oscillator timeframe fetchers (60m, 30m) ─────────────────────────

async function fetch60mCandles(ticker: string): Promise<Candle[]> {
  const to = new Date();
  const from = new Date();
  // 60 calendar days (~40 trading days, ~260 bars) — enough for EMA(21) convergence
  from.setDate(from.getDate() - 60);
  const candles = await fetchAggs(ticker, 60, "minute", formatDate(from), formatDate(to));
  return filterMarketHours(candles);
}

async function fetch30mCandles(ticker: string): Promise<Candle[]> {
  const to = new Date();
  const from = new Date();
  // 45 calendar days (~30 trading days, ~390 bars) — enough for EMA(21) convergence
  from.setDate(from.getDate() - 45);
  const candles = await fetchAggs(ticker, 30, "minute", formatDate(from), formatDate(to));
  return filterMarketHours(candles);
}

export async function fetchPhaseTimeframes(ticker: string): Promise<{
  weekly: Candle[];
  daily: Candle[];
  m60: Candle[];
  m30: Candle[];
}> {
  // Check cache for slow-changing timeframes
  let weekly = await getCachedCandles(ticker, "weekly");
  let daily = await getCachedCandles(ticker, "daily");

  const fetches: Promise<void>[] = [];

  if (!weekly) {
    fetches.push(fetchWeeklyCandles(ticker).then(async (c) => { weekly = c; await setCachedCandles(ticker, "weekly", c); }));
  }
  if (!daily) {
    fetches.push(fetchDailyCandles(ticker).then(async (c) => { daily = c; await setCachedCandles(ticker, "daily", c); }));
  }

  // Intraday always fresh
  let m60: Candle[] = [];
  let m30: Candle[] = [];
  fetches.push(fetch60mCandles(ticker).then((c) => { m60 = c; }));
  fetches.push(fetch30mCandles(ticker).then((c) => { m30 = c; }));

  await Promise.all(fetches);

  return { weekly: weekly!, daily: daily!, m60, m30 };
}

// ─── Ticker Details (industry/sector) ────────────────────────────────────────

export interface TickerInfo {
  name: string;
  industry: string;
  sector: string;
}

const tickerInfoCache = new Map<string, TickerInfo>();

export async function fetchTickerInfo(ticker: string): Promise<TickerInfo> {
  const cached = tickerInfoCache.get(ticker);
  if (cached) return cached;

  const url = `${BASE_URL}/v3/reference/tickers/${ticker}?apiKey=${getApiKey()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { name: ticker, industry: "—", sector: "—" };
    }
    const data = await res.json() as {
      results?: {
        name?: string;
        sic_description?: string;
        // Polygon v3 doesn't have a direct "sector" field, but sic_description covers industry
      };
    };
    const r = data.results;
    const info: TickerInfo = {
      name: r?.name ?? ticker,
      industry: r?.sic_description ?? "—",
      sector: "—",
    };
    tickerInfoCache.set(ticker, info);
    return info;
  } catch {
    return { name: ticker, industry: "—", sector: "—" };
  }
}

// ─── Main entry point — uses candle cache for weekly/daily ───────────────────

export async function fetchAllTimeframes(ticker: string): Promise<{
  weekly: Candle[];
  daily: Candle[];
  m65: Candle[];
  m10: Candle[];
}> {
  // Check cache for slow-changing timeframes
  let weekly = await getCachedCandles(ticker, "weekly");
  let daily = await getCachedCandles(ticker, "daily");

  // Build list of fetches we actually need
  const fetches: Promise<void>[] = [];

  if (!weekly) {
    fetches.push(fetchWeeklyCandles(ticker).then(async (c) => { weekly = c; await setCachedCandles(ticker, "weekly", c); }));
  }
  if (!daily) {
    fetches.push(fetchDailyCandles(ticker).then(async (c) => { daily = c; await setCachedCandles(ticker, "daily", c); }));
  }

  // Intraday always fresh
  let m65: Candle[] = [];
  let m10: Candle[] = [];
  fetches.push(fetch65mCandles(ticker).then((c) => { m65 = c; }));
  fetches.push(fetch10mCandles(ticker).then((c) => { m10 = c; }));

  await Promise.all(fetches);

  return { weekly: weekly!, daily: daily!, m65, m10 };
}
