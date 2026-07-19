import Redis from "ioredis";

/**
 * Shared plumbing for the Rotation tab (ported from the standalone
 * sector-rotation app's Python API).
 *
 * Everything the panels need comes from two Polygon endpoints:
 *   - snapshot/tickers  → live quotes for the whole universe
 *   - aggs/grouped      → one day's OHLC for the ENTIRE market in one call
 *
 * The grouped endpoint is the expensive one (~10k rows per call), and the
 * original app re-fetched the same dates repeatedly — `weekly-history` alone
 * could issue 40 calls, with adjacent weeks re-requesting overlapping days.
 * `fetchGroupedDaily` below memoises per date, so a 4-week history costs at
 * most 8 distinct fetches instead of 40.
 *
 * Deliberate fixes vs. the Python original, all of which were silent failures:
 *   1. ET is a real timezone (America/New_York), not a hardcoded UTC-5 — the
 *      original was an hour off for ~8 months of the year, which near midnight
 *      selected the wrong "today".
 *   2. A Polygon HTTP error is distinguished from "not a trading day". The
 *      original treated them identically, so a 429 silently walked backwards
 *      through five days and dropped an entire week with no error surfaced.
 *   3. Errors never leak stack traces to the client.
 *   4. Redis actually works. The Python app imported `redis` but never listed
 *      it in requirements.txt, so every deploy silently ran on a per-worker
 *      dict that died on cold start — meaning the cache it appeared to have
 *      was largely fictional.
 */

// ─── Redis (lazy, same pattern as candleCache.ts) ────────────────────────────

let redis: Redis | null = null;
let redisTried = false;

function getRedis(): Redis | null {
  if (redisTried) return redis;
  redisTried = true;

  const connStr = process.env.REDIS_CONNECTION_STRING;
  if (!connStr) return null;

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

interface MemEntry {
  value: unknown;
  expiresAt: number;
}
const memCache = new Map<string, MemEntry>();

/** Read a cached JSON value. Redis first, in-memory fallback, null on miss. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get(key);
      if (raw) return JSON.parse(raw) as T;
      return null;
    } catch {
      // fall through to memory — Redis being down degrades, never fails
    }
  }
  const hit = memCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  if (hit) memCache.delete(key);
  return null;
}

/** Write a cached JSON value with a TTL in seconds. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.set(key, JSON.stringify(value), "EX", ttlSeconds);
      return;
    } catch {
      // fall through
    }
  }
  memCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ─── Dates (real Eastern time) ───────────────────────────────────────────────

/**
 * Today's date in US Eastern time as YYYY-MM-DD.
 *
 * `en-CA` yields ISO-ordered parts, which is why it is used here rather than
 * assembling the string by hand.
 */
export function easternToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Shift a YYYY-MM-DD date by whole days, staying date-only (no tz drift). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string. */
export function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Monday of the week containing `dateStr` (Monday returns itself). */
export function mondayOf(dateStr: string): string {
  const dow = dayOfWeek(dateStr);
  // Sunday (0) belongs to the week that started six days earlier.
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(dateStr, -back);
}

/** The first day of the month containing `dateStr`. */
export function firstOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

// ─── Polygon ─────────────────────────────────────────────────────────────────

const SNAPSHOT_URL = "https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers";
const GROUPED_URL = "https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks";

function apiKey(): string {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error("POLYGON_API_KEY not configured");
  return k;
}

export interface GroupedBar {
  T: string; // ticker
  o: number; // open
  c: number; // close
  h: number;
  l: number;
  v: number;
}

/** Distinguishes "no data for this date" from "the request failed". */
type GroupedOutcome =
  | { kind: "ok"; bars: GroupedBar[] }
  | { kind: "empty" } // valid response, zero results → not a trading day
  | { kind: "error"; message: string };

// Memoise per date for the lifetime of the invocation. Grouped payloads are
// ~10k rows, and a 4-week history would otherwise re-fetch overlapping days.
const groupedMemo = new Map<string, Promise<GroupedOutcome>>();

async function fetchGroupedOnce(date: string): Promise<GroupedOutcome> {
  const url = `${GROUPED_URL}/${date}?adjusted=true&apiKey=${apiKey()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      return { kind: "error", message: `Polygon HTTP ${res.status} for ${date}` };
    }
    const data = (await res.json()) as { resultsCount?: number; results?: GroupedBar[] };
    if (!data.resultsCount || !data.results?.length) return { kind: "empty" };
    return { kind: "ok", bars: data.results };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "fetch failed" };
  }
}

/** Grouped daily bars for one date, memoised across a single invocation. */
export function fetchGroupedDaily(date: string): Promise<GroupedOutcome> {
  let p = groupedMemo.get(date);
  if (!p) {
    p = fetchGroupedOnce(date);
    groupedMemo.set(date, p);
  }
  return p;
}

export interface TradingDay {
  date: string;
  bars: GroupedBar[];
}

/**
 * Walk from `start` until a trading day is found.
 *
 * Unlike the original, a transport error aborts the walk with a thrown error
 * instead of being mistaken for a market holiday. Silently skipping five days
 * because Polygon rate-limited you produced a plausible-looking result built
 * on the wrong dates.
 */
export async function findTradingDay(
  start: string,
  direction: "forward" | "backward",
  maxTries = 5,
): Promise<TradingDay | null> {
  let date = start;
  for (let i = 0; i < maxTries; i += 1) {
    const out = await fetchGroupedDaily(date);
    if (out.kind === "ok") return { date, bars: out.bars };
    if (out.kind === "error") throw new Error(out.message);
    date = addDays(date, direction === "backward" ? -1 : 1);
  }
  return null;
}

export interface Quote {
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  vwap: number;
  changePercent: number;
  changeFromOpenPercent: number;
}

/**
 * Live snapshot quotes for the given tickers, in batches of 100.
 *
 * Note on market cap: the snapshot endpoint does not return it. The original
 * app did `ticker_data.get("market_cap", 1)`, which ALWAYS fell through to 1 —
 * so its circle-packing view rendered uniformly sized circles while appearing
 * to be cap-weighted. Rather than reproduce a fake field, market cap is simply
 * absent here; a caller that needs it must fetch /v3/reference/tickers.
 */
export async function fetchQuotes(tickers: string[]): Promise<Record<string, Quote>> {
  const quotes: Record<string, Quote> = {};
  const BATCH = 100;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const url = `${SNAPSHOT_URL}?tickers=${batch.join(",")}&apiKey=${apiKey()}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue; // partial data beats no data
      const data = (await res.json()) as {
        status?: string;
        tickers?: Array<{
          ticker?: string;
          day?: { o?: number; c?: number; h?: number; l?: number; v?: number; vw?: number };
          lastTrade?: { p?: number };
          min?: { c?: number };
          todaysChangePerc?: number;
        }>;
      };
      if (data.status !== "OK" || !data.tickers) continue;

      for (const t of data.tickers) {
        const symbol = t.ticker;
        if (!symbol) continue;
        const day = t.day ?? {};
        const min = t.min ?? {};

        // lastTrade.p is frequently absent outside RTH; fall back to the day
        // close then the last minute bar. Uses `||` deliberately, NOT `??`:
        // a genuine 0 must fall through, which `??` would not do.
        const price = t.lastTrade?.p || day.c || min.c || 0;
        const open = day.o ?? 0;

        quotes[symbol] = {
          price,
          open,
          high: day.h ?? 0,
          low: day.l ?? 0,
          volume: day.v ?? 0,
          vwap: day.vw ?? 0,
          changePercent: t.todaysChangePerc ?? 0,
          changeFromOpenPercent:
            open > 0 && price ? Math.round(((price - open) / open) * 10000) / 100 : 0,
        };
      }
    } catch {
      continue; // skip the batch, keep the rest
    }
  }

  return quotes;
}

/**
 * Percent change from the open of `start` to the close of `end`, per ticker.
 * Matches the original: `(endClose - startOpen) / startOpen * 100`, 2dp.
 */
export function computePerformance(
  start: TradingDay,
  end: TradingDay,
  universe: Set<string>,
): Record<string, number> {
  const startOpen = new Map<string, number>();
  for (const b of start.bars) if (universe.has(b.T)) startOpen.set(b.T, b.o);

  const endClose = new Map<string, number>();
  for (const b of end.bars) if (universe.has(b.T)) endClose.set(b.T, b.c);

  const perf: Record<string, number> = {};
  for (const [ticker, sp] of startOpen) {
    const ep = endClose.get(ticker);
    if (sp > 0 && ep !== undefined && ep > 0) {
      perf[ticker] = Math.round(((ep - sp) / sp) * 10000) / 100;
    }
  }
  return perf;
}
