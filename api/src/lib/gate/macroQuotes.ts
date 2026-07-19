// Ported from ShouldIBeTrading — REPLACES the source's yahoo.ts.
//
// Deliberate behaviour change vs. the source:
//   1. Polygon FIRST (aggregate/snapshot endpoints only — this plan has no
//      real-time entitlement, so last-trade/quote return NOT_AUTHORIZED),
//      Yahoo only as a fallback when Polygon returns nothing usable.
//   2. Both paths run through a sanity guard. The source failed soft to 0,
//      so a dead quote produced "VIX = 0" which scored as a spuriously
//      BULLISH ultra-low-volatility regime. Anything non-positive or absurd
//      is now rejected and reported via `degraded` + `warnings`.

import type { Candle } from "./types.js";
import { MACRO_TICKERS, VIX_INDEX_TICKER } from "./constants.js";
import { fetchIndexDailyBars, fetchIndexSnapshot, fetchVixSnapshot } from "./polygon.js";

export type QuoteSource = "polygon" | "yahoo" | "none";

export interface MacroQuote {
  /** Current level. 0 only when `degraded` is true and nothing was usable. */
  price: number;
  /** Absolute change vs. previous close (0 when unknown). */
  change: number;
  bars: Candle[];
  source: QuoteSource;
  degraded: boolean;
  warnings: string[];
}

// ─── Sanity guards ────────────────────────────────────────────
// Plausible ranges. Outside these the value is treated as bad data, never
// as a real reading.
const RANGES: Record<string, { min: number; max: number; label: string }> = {
  VIX: { min: 0, max: 200, label: "VIX" },
  // Polygon/Yahoo both quote the 10y around 0.3–20 (percent). Yahoo's ^TNX is
  // the yield itself; some feeds publish yield × 10. Accept both scales.
  TNX: { min: 0, max: 250, label: "TNX" },
  DXY: { min: 10, max: 300, label: "DXY" },
};

function isSane(kind: keyof typeof RANGES | string, value: number | null | undefined): boolean {
  const r = RANGES[kind];
  if (value == null || !Number.isFinite(value)) return false;
  if (value <= 0) return false;
  if (!r) return true;
  return value > r.min && value <= r.max;
}

/** Drop bars whose close is not a plausible value for this series. */
function sanitizeBars(kind: string, bars: Candle[]): Candle[] {
  return bars.filter((b) => isSane(kind, b.c));
}

// ─── Yahoo fallback ───────────────────────────────────────────

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

interface YahooChartResult {
  meta: {
    regularMarketPrice: number;
    chartPreviousClose: number;
  };
  timestamp: number[];
  indicators: {
    quote: Array<{
      open: (number | null)[];
      high: (number | null)[];
      low: (number | null)[];
      close: (number | null)[];
      volume: (number | null)[];
    }>;
  };
}

interface YahooResponse {
  chart: {
    result: YahooChartResult[] | null;
    error: unknown;
  };
}

async function fetchYahooChart(
  symbol: string,
  range: string,
  interval: string,
): Promise<{ price: number; prevClose: number; bars: Candle[] }> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;

  let data: YahooResponse;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { price: 0, prevClose: 0, bars: [] };
    data = (await res.json()) as YahooResponse;
  } catch {
    return { price: 0, prevClose: 0, bars: [] };
  }

  if (!data.chart?.result || data.chart.result.length === 0) {
    return { price: 0, prevClose: 0, bars: [] };
  }

  const result = data.chart.result[0];
  const price = result.meta?.regularMarketPrice ?? 0;
  const prevClose = result.meta?.chartPreviousClose ?? 0;

  const bars: Candle[] = [];
  const q = result.indicators?.quote?.[0];
  const timestamps = result.timestamp;

  if (timestamps && q) {
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open[i];
      const h = q.high[i];
      const l = q.low[i];
      const c = q.close[i];
      const v = q.volume[i];
      if (o != null && h != null && l != null && c != null) {
        bars.push({ o, h, l, c, v: v ?? 0, t: timestamps[i] * 1000 });
      }
    }
  }

  return { price, prevClose, bars };
}

// ─── Generic resolve: polygon first, yahoo fallback ───────────

interface ResolveArgs {
  kind: string;
  polygon: () => Promise<{ price: number; change: number; bars: Candle[] }>;
  yahooSymbol: string;
  yahooRange: string;
}

async function resolve({ kind, polygon, yahooSymbol, yahooRange }: ResolveArgs): Promise<MacroQuote> {
  const warnings: string[] = [];

  // 1) Polygon
  try {
    const p = await polygon();
    const bars = sanitizeBars(kind, p.bars);
    const price = isSane(kind, p.price)
      ? p.price
      : bars.length > 0
        ? bars[bars.length - 1].c
        : 0;

    if (isSane(kind, price)) {
      if (!isSane(kind, p.price) && bars.length > 0) {
        warnings.push(`${kind}: Polygon live value rejected by sanity guard; using latest daily close.`);
      }
      if (p.bars.length !== bars.length) {
        warnings.push(`${kind}: dropped ${p.bars.length - bars.length} implausible Polygon bar(s).`);
      }
      return {
        price,
        change: Number.isFinite(p.change) ? p.change : 0,
        bars,
        source: "polygon",
        degraded: warnings.length > 0,
        warnings,
      };
    }
    warnings.push(`${kind}: Polygon returned no usable value — falling back to Yahoo.`);
  } catch (err) {
    warnings.push(`${kind}: Polygon fetch failed (${(err as Error).message}) — falling back to Yahoo.`);
  }

  // 2) Yahoo fallback
  const y = await fetchYahooChart(yahooSymbol, yahooRange, "1d");
  const yBars = sanitizeBars(kind, y.bars);
  const yPrice = isSane(kind, y.price)
    ? y.price
    : yBars.length > 0
      ? yBars[yBars.length - 1].c
      : 0;

  if (isSane(kind, yPrice)) {
    const change = isSane(kind, y.prevClose) ? yPrice - y.prevClose : 0;
    return {
      price: yPrice,
      change,
      bars: yBars,
      source: "yahoo",
      degraded: true, // fallback path is by definition degraded
      warnings,
    };
  }

  // 3) Nothing usable. Report it loudly instead of returning a fake 0 that
  //    would score as a calm, bullish tape.
  warnings.push(`${kind}: no usable quote from Polygon or Yahoo — score for this input is unreliable.`);
  return { price: 0, change: 0, bars: [], source: "none", degraded: true, warnings };
}

// ─── VIX ──────────────────────────────────────────────────────

export interface VixQuote extends MacroQuote {
  /** Alias of `price`, matching the source's fetchVixData() shape. */
  level: number;
}

export async function fetchVixData(): Promise<VixQuote> {
  const q = await resolve({
    kind: "VIX",
    polygon: async () => {
      const [snap, bars] = await Promise.all([
        fetchVixSnapshot(),
        fetchIndexDailyBars(VIX_INDEX_TICKER, 365),
      ]);
      return {
        price: snap?.level ?? 0,
        change: snap?.change ?? 0,
        bars,
      };
    },
    yahooSymbol: "^VIX",
    yahooRange: "1y",
  });

  return { ...q, level: q.price };
}

// ─── TNX (10-Year Treasury Yield) ─────────────────────────────

export async function fetchTnxData(): Promise<MacroQuote> {
  return resolve({
    kind: "TNX",
    polygon: async () => {
      const [snapMap, bars] = await Promise.all([
        fetchIndexSnapshot([MACRO_TICKERS.TNX]),
        fetchIndexDailyBars(MACRO_TICKERS.TNX, 30),
      ]);
      const snap = snapMap.get(MACRO_TICKERS.TNX);
      return { price: snap?.value ?? 0, change: snap?.change ?? 0, bars };
    },
    yahooSymbol: "^TNX",
    yahooRange: "1mo",
  });
}

// ─── DXY (US Dollar Index) ────────────────────────────────────

export async function fetchDxyData(): Promise<MacroQuote> {
  return resolve({
    kind: "DXY",
    polygon: async () => {
      const [snapMap, bars] = await Promise.all([
        fetchIndexSnapshot([MACRO_TICKERS.DXY]),
        fetchIndexDailyBars(MACRO_TICKERS.DXY, 30),
      ]);
      const snap = snapMap.get(MACRO_TICKERS.DXY);
      return { price: snap?.value ?? 0, change: snap?.change ?? 0, bars };
    },
    yahooSymbol: "DX-Y.NYB",
    yahooRange: "1mo",
  });
}

/** Roll several quotes into one data-quality verdict for the response. */
export function summarizeQuality(quotes: MacroQuote[]): { degraded: boolean; warnings: string[] } {
  const warnings = quotes.flatMap((q) => q.warnings);
  return { degraded: quotes.some((q) => q.degraded), warnings };
}
