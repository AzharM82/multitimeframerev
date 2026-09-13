/**
 * Tradier market data for the portal.
 *
 * The brokerage account carries real-time Level 1 for US stocks and options
 * (OPRA), option chains with ORATS greeks, time and sales, the market clock and
 * the calendar — free to account holders, no per-feed subscription. That is why
 * this file exists: several tabs here are built on workarounds that only exist
 * because Polygon has no real-time entitlement on our plan.
 *
 * READ-ONLY on purpose. This portal never places an order; the executor lives in
 * StockAgentHub with its own copy of the token. Nothing here touches
 * /v1/accounts, so a leaked call cannot move money.
 *
 * The token is a personal one from the Tradier settings page and does not
 * expire. It is read from TRADIER_TOKEN and never logged. The rate limit is 120
 * market-data calls a minute per token, shared with the hub's executor; every
 * response's X-Ratelimit headers are remembered so a caller can see the budget.
 */

const BASE = "https://api.tradier.com";

export class TradierError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`Tradier ${status} ${path}: ${body.slice(0, 160)}`);
    this.name = "TradierError";
    this.status = status;
  }
}

export function tradierConfigured(): boolean {
  return Boolean((process.env.TRADIER_TOKEN || "").trim());
}

/** Remaining calls in the current minute, as of the last response. */
export const rateLimit: { allowed?: string; used?: string; available?: string; expiry?: string } = {};

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const token = (process.env.TRADIER_TOKEN || "").trim();
  if (!token) throw new TradierError(0, path, "TRADIER_TOKEN is not set");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);

  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  for (const k of ["allowed", "used", "available", "expiry"] as const) {
    const h = res.headers.get(`X-Ratelimit-${k[0].toUpperCase()}${k.slice(1)}`);
    if (h) rateLimit[k] = h;
  }
  if (!res.ok) throw new TradierError(res.status, path, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

/** Tradier returns a bare object for one row and an array for many. */
function many<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export interface TradierQuote {
  symbol: string;
  description?: string;
  type?: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  prevclose?: number | null;
  change_percentage?: number | null;
  volume?: number | null;
  /** Epoch ms of the last trade — the honest "as of" for a real-time quote. */
  trade_date?: number | null;
  greeks?: {
    delta?: number | null; gamma?: number | null; theta?: number | null; vega?: number | null;
    mid_iv?: number | null; smv_vol?: number | null; updated_at?: string | null;
  } | null;
  open_interest?: number | null;
  strike?: number | null;
  option_type?: "put" | "call" | null;
  expiration_date?: string | null;
  underlying?: string | null;
}

/** Up to a few hundred symbols per call; the caller should chunk long lists. */
export async function quotes(symbols: string[], greeks = false): Promise<TradierQuote[]> {
  if (!symbols.length) return [];
  const d = await get<{ quotes?: { quote?: TradierQuote | TradierQuote[]; unmatched_symbols?: unknown } }>(
    "/v1/markets/quotes", { symbols: symbols.join(","), greeks: greeks ? "true" : "false" },
  );
  return many(d.quotes?.quote);
}

export async function quote(symbol: string, greeks = false): Promise<TradierQuote | null> {
  return (await quotes([symbol], greeks))[0] ?? null;
}

export async function expirations(symbol: string): Promise<string[]> {
  const d = await get<{ expirations?: { date?: string | string[] } }>(
    "/v1/markets/options/expirations", { symbol, includeAllRoots: "true" },
  );
  return many(d.expirations?.date);
}

export async function optionChain(symbol: string, expiration: string, greeks = true): Promise<TradierQuote[]> {
  const d = await get<{ options?: { option?: TradierQuote | TradierQuote[] } }>(
    "/v1/markets/options/chains", { symbol, expiration, greeks: greeks ? "true" : "false" },
  );
  return many(d.options?.option);
}

export interface TimeSaleBar { time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number; vwap?: number }

/** interval: tick | 1min | 5min | 15min. start/end are ET "YYYY-MM-DD HH:MM". */
export async function timesales(symbol: string, interval: string, start: string, end: string, sessionFilter = "open"): Promise<TimeSaleBar[]> {
  const d = await get<{ series?: { data?: TimeSaleBar | TimeSaleBar[] } }>(
    "/v1/markets/timesales", { symbol, interval, start, end, session_filter: sessionFilter },
  );
  return many(d.series?.data);
}

export interface MarketClock { state: string; description?: string; next_change?: string; timestamp?: number }

export async function clock(): Promise<MarketClock> {
  const d = await get<{ clock?: MarketClock }>("/v1/markets/clock", {});
  return d.clock ?? { state: "unknown" };
}

export interface CalendarDay { date: string; status: "open" | "closed"; description?: string; open?: { start: string; end: string } }

export async function calendar(month: number, year: number): Promise<CalendarDay[]> {
  const d = await get<{ calendar?: { days?: { day?: CalendarDay | CalendarDay[] } } }>(
    "/v1/markets/calendar", { month: String(month), year: String(year) },
  );
  return many(d.calendar?.days?.day);
}
