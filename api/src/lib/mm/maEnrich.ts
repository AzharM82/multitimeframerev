/**
 * Moving-average enrichment for the Sector Desk.
 *
 * Provides the two MA families FinViz can't: daily EMA(10)/EMA(20) and the
 * "5-day" line = a 65-period SMA on 30-minute bars (5 trading days × 13
 * half-hour RTH bars). FinViz already gives SMA50/SMA200 distance + change from
 * open, so those are NOT computed here.
 *
 * Sources (both verified live 2026-08-06):
 *  - EMA10/20: Polygon **grouped daily bars** — one call returns every US
 *    stock's bar for a date, so ~50 calls cover the whole market's history.
 *    Returned as the EMA through the last COMPLETED session; the caller applies
 *    the live price for the current (intraday) value. Cached once per ET day.
 *  - 5-day: **Alpaca IEX** 30-minute bars, multi-symbol batched. Polygon's tier
 *    here does NOT serve regular-session intraday bars (only sparse extended-
 *    hours), so Alpaca IEX is the source. Cached ~25 min (30-min bars are slow).
 *
 * All levels are returned as price LEVELS; the Sector Desk computes the % distance
 * against FinViz's real-time price so the distances stay live.
 */

const POLY_BASE = "https://api.polygon.io";
const ALPACA_DATA = "https://data.alpaca.markets";

export interface MaLevels {
  /** EMA through the last completed daily close (caller folds in live price). */
  emaPrev10: number | null;
  emaPrev20: number | null;
  /** 65-bar 30-min SMA (the "5-day" line). */
  fiveDay: number | null;
}

// ── small helpers ───────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pMap<T, R>(items: T[], fn: (t: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

/** { ymd: 'YYYY-MM-DD', weekend: bool } for a Date, in ET. */
function etParts(d: Date): { ymd: string; weekend: boolean } {
  const parts = etFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const wd = get("weekday");
  return { ymd, weekend: wd === "Sat" || wd === "Sun" };
}

function etToday(): string {
  return etParts(new Date()).ymd;
}

/** The last `n` ET weekdays strictly before today, ascending. Holidays are left
 * in (grouped returns empty for them, harmlessly skipped when building closes). */
function lastWeekdays(n: number): string[] {
  const out: string[] = [];
  const today = etToday();
  const now = Date.now();
  for (let i = 1; out.length < n && i < n * 2 + 20; i += 1) {
    const p = etParts(new Date(now - i * 86_400_000));
    if (p.weekend || p.ymd === today) continue;
    out.push(p.ymd);
  }
  return out.reverse();
}

function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i += 1) e = closes[i] * k + e * (1 - k);
  return e;
}

// ── Polygon grouped daily → EMA map ─────────────────────────────────────────

interface EmaEntry {
  ema10: number | null;
  ema20: number | null;
}
let emaCache: { date: string; map: Map<string, EmaEntry> } | null = null;

async function fetchGroupedDay(date: string, key: string): Promise<Array<{ T: string; c: number }>> {
  const url = `${POLY_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${key}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) { await sleep(2 ** attempt * 1500); continue; }
      if (!res.ok) return [];
      const j = (await res.json()) as { results?: Array<{ T: string; c: number }> };
      return j.results ?? [];
    } catch { return []; }
  }
  return [];
}

async function buildEmaMap(key: string): Promise<Map<string, EmaEntry>> {
  const dates = lastWeekdays(50); // ascending
  const perDay = await pMap(dates, (d) => fetchGroupedDay(d, key), 8);
  // ticker -> closes, oldest→newest (perDay is already ascending by date)
  const closes = new Map<string, number[]>();
  for (const rows of perDay) {
    for (const r of rows) {
      if (!r.T || typeof r.c !== "number" || r.c <= 0) continue;
      let arr = closes.get(r.T);
      if (!arr) { arr = []; closes.set(r.T, arr); }
      arr.push(r.c);
    }
  }
  const map = new Map<string, EmaEntry>();
  for (const [t, arr] of closes) {
    const e10 = ema(arr, 10);
    const e20 = ema(arr, 20);
    if (e10 !== null || e20 !== null) map.set(t, { ema10: e10, ema20: e20 });
  }
  return map;
}

// ── Alpaca IEX 30-min → 5-day (65-bar SMA) map ──────────────────────────────

const FIVE_DAY_TTL_MS = 25 * 60 * 1000;
const FIVE_DAY_BARS = 65;
let fiveDayCache: { at: number; map: Map<string, number> } | null = null;

/** Is a bar timestamp inside the RTH session (9:30–16:00 ET)? Uses UTC minutes;
 * 13:30–20:00 UTC covers standard time and 12:30–19:00 during DST — we accept
 * both by bracketing 12:30–20:00, which excludes pre/post-market either way. */
function isRth(iso: string): boolean {
  const d = new Date(iso);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 12 * 60 + 30 && mins < 20 * 60;
}

async function fetchAlpacaBatch(
  symbols: string[],
  startIso: string,
  keyId: string,
  secret: string,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const url =
    `${ALPACA_DATA}/v2/stocks/bars?symbols=${symbols.join(",")}` +
    `&timeframe=30Min&start=${startIso}&feed=iex&limit=10000&sort=asc&adjustment=split`;
  // Alpaca's multi-symbol response returns only a handful of symbols per page
  // (independent of `limit`), so we must follow next_page_token to completion —
  // a ~90-symbol batch runs ~25 pages. Cap is a safety stop, not the norm.
  let pageToken = "";
  for (let page = 0; page < 60; page += 1) {
    const u = pageToken ? `${url}&page_token=${pageToken}` : url;
    let j: { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
    try {
      const res = await fetch(u, {
        headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) break;
      j = await res.json();
    } catch { break; }
    for (const [sym, bars] of Object.entries(j.bars ?? {})) {
      let arr = out.get(sym);
      if (!arr) { arr = []; out.set(sym, arr); }
      for (const b of bars) if (isRth(b.t)) arr.push(b.c);
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  return out;
}

async function build5DayMap(tickers: string[], keyId: string, secret: string): Promise<Map<string, number>> {
  // 8 calendar days back is enough for 65 RTH 30-min bars (5 trading days).
  const start = new Date(Date.now() - 9 * 86_400_000).toISOString();
  const map = new Map<string, number>();
  const BATCH = 90;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    const bars = await fetchAlpacaBatch(chunk, start, keyId, secret);
    for (const [sym, closes] of bars) {
      if (closes.length < FIVE_DAY_BARS) continue; // not enough history → skip
      const last = closes.slice(-FIVE_DAY_BARS);
      map.set(sym, last.reduce((a, b) => a + b, 0) / last.length);
    }
  }
  return map;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * MA levels for the given tickers. EMAs come from a once-per-day Polygon build;
 * the 5-day line from a ~25-min-cached Alpaca build that is extended (not
 * refetched wholesale) as new tickers are requested through the day.
 */
export async function getMaLevels(tickers: string[]): Promise<Map<string, MaLevels>> {
  const polyKey = (process.env.POLYGON_API_KEY ?? "").trim();
  const alpKey = (process.env.ALPACA_API_KEY ?? "").trim();
  const alpSec = (process.env.ALPACA_API_SECRET ?? "").trim();
  const want = [...new Set(tickers.map((t) => t.toUpperCase()))];

  // EMA map — rebuild when the ET day rolls over.
  const today = etToday();
  if (polyKey && (!emaCache || emaCache.date !== today)) {
    try { emaCache = { date: today, map: await buildEmaMap(polyKey) }; }
    catch { emaCache = emaCache ?? { date: today, map: new Map() }; }
  }

  // 5-day map — rebuild when stale, or when we're asked for tickers we don't have.
  const now = Date.now();
  const stale = !fiveDayCache || now - fiveDayCache.at > FIVE_DAY_TTL_MS;
  const missing = fiveDayCache ? want.filter((t) => !fiveDayCache!.map.has(t)) : want;
  if (alpKey && alpSec && (stale || missing.length > 0)) {
    try {
      if (stale) {
        fiveDayCache = { at: now, map: await build5DayMap(want, alpKey, alpSec) };
      } else if (missing.length > 0) {
        const add = await build5DayMap(missing, alpKey, alpSec);
        for (const [k, v] of add) fiveDayCache!.map.set(k, v);
      }
    } catch { /* keep whatever we had */ }
  }

  const result = new Map<string, MaLevels>();
  for (const t of want) {
    const e = emaCache?.map.get(t);
    result.set(t, {
      emaPrev10: e?.ema10 ?? null,
      emaPrev20: e?.ema20 ?? null,
      fiveDay: fiveDayCache?.map.get(t) ?? null,
    });
  }
  return result;
}

/** Fold today's live price into an EMA-through-yesterday to get the current EMA. */
export function currentEma(emaPrev: number | null, livePrice: number, period: number): number | null {
  if (emaPrev === null || livePrice <= 0) return null;
  const k = 2 / (period + 1);
  return livePrice * k + emaPrev * (1 - k);
}

/** Signed % distance of price from a level (positive = above). */
export function distPct(price: number, level: number | null): number | null {
  if (level === null || level <= 0 || price <= 0) return null;
  return (price / level - 1) * 100;
}
