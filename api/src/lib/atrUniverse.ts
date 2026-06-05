/**
 * ATR Matrix universe — the full index map, pulled from Finviz Elite.
 *
 * The matrix is meant to map a whole liquid universe (every zone from LEAVE to
 * BLOW-OFF), not a pre-filtered uptrend screen. We pull the S&P 500 + Nasdaq 100
 * from the Finviz custom export, which carries Price, ATR, the 20/50/200-day SMA
 * distances, performance returns, volatility and avg-volume as columns — so the
 * entire matrix is computed from ONE call per index, with no Polygon load.
 *
 * Column ids (verified against the live export, 2026-06): they have drifted from
 * older references, so we map by header NAME, not position.
 *   1 Ticker · 2 Company · 3 Sector · 4 Industry · 6 Market Cap(M) ·
 *   63 Avg Volume(K) · 65 Price · 66 Change · 67 Volume · 49 ATR ·
 *   52/53/54 SMA20/50/200 dist · 42/43/44/45/47 Perf W/M/Q/H/YTD · 50 Volatility(W)
 */

import { fetchExportFromUrl, isEliteConfigured } from "./finvizElite.js";

const MATRIX_INDICES: { tag: string; filter: string }[] = [
  { tag: "SP500", filter: "idx_sp500" },
  { tag: "NDX", filter: "idx_ndx" },
];

const MATRIX_COLUMNS = "1,2,3,4,6,63,65,66,67,49,52,53,54,42,43,44,45,47,50,86";

export interface FinvizMatrixRow {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number; // dollars
  avgVol: number; // shares
  price: number;
  open: number; // session open
  change: number; // %
  rvol: number; // today's volume / avg volume (relative volume)
  atr: number; // $
  d20: number; // % distance of price from SMA20 (positive = above)
  d50: number;
  d200: number;
  perfW: number; // % returns
  perfM: number;
  perfQ: number;
  perfH: number;
  perfYTD: number;
  volWeek: number; // weekly volatility %
  indexes: string[];
}

/** Parse a Finviz numeric/percent cell ("17.45%", "138.37", "-") → number|null. */
function num(s: string | undefined): number | null {
  if (s === undefined || s === null) return null;
  const t = s.replace("%", "").replace(/,/g, "").trim();
  if (!t || t === "-") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function parseRow(r: Record<string, string>, tag: string): FinvizMatrixRow | null {
  const ticker = (r["Ticker"] || "").toUpperCase();
  const price = num(r["Price"]);
  const atr = num(r["Average True Range"]);
  const d50 = num(r["50-Day Simple Moving Average"]);
  if (!ticker || price === null || atr === null || d50 === null) return null;
  const avgVol = (num(r["Average Volume"]) ?? 0) * 1e3; // thousands → shares
  const volToday = num(r["Volume"]) ?? 0; // EOD: full-day volume
  return {
    ticker,
    company: r["Company"] ?? "",
    sector: r["Sector"] ?? "",
    industry: r["Industry"] ?? "",
    marketCap: (num(r["Market Cap"]) ?? 0) * 1e6, // Finviz custom export = millions
    avgVol,
    price,
    open: num(r["Open"]) ?? price,
    change: num(r["Change"]) ?? 0,
    rvol: avgVol > 0 ? Math.round((volToday / avgVol) * 100) / 100 : 0,
    atr,
    d20: num(r["20-Day Simple Moving Average"]) ?? 0,
    d50,
    d200: num(r["200-Day Simple Moving Average"]) ?? 0,
    perfW: num(r["Performance (Week)"]) ?? 0,
    perfM: num(r["Performance (Month)"]) ?? 0,
    perfQ: num(r["Performance (Quarter)"]) ?? 0,
    perfH: num(r["Performance (Half Year)"]) ?? 0,
    perfYTD: num(r["Performance (YTD)"]) ?? 0,
    volWeek: num(r["Volatility (Week)"]) ?? 0,
    indexes: [tag],
  };
}

/**
 * Pull the S&P 500 + Nasdaq 100 constituents, deduped by ticker (a name in both
 * indices carries both tags). Throws if Finviz is unconfigured or returns nothing.
 */
export async function pullMatrixUniverse(): Promise<FinvizMatrixRow[]> {
  if (!isEliteConfigured()) {
    throw new Error("FINVIZ_API_KEY is not set — cannot pull ATR Matrix universe");
  }
  const byTicker = new Map<string, FinvizMatrixRow>();
  for (const idx of MATRIX_INDICES) {
    const url = `https://elite.finviz.com/export?v=152&f=${idx.filter}&c=${MATRIX_COLUMNS}`;
    const rows = await fetchExportFromUrl(url, `atr:${idx.filter}`);
    for (const raw of rows) {
      const parsed = parseRow(raw, idx.tag);
      if (!parsed) continue;
      const existing = byTicker.get(parsed.ticker);
      if (existing) {
        if (!existing.indexes.includes(idx.tag)) existing.indexes.push(idx.tag);
      } else {
        byTicker.set(parsed.ticker, parsed);
      }
    }
  }
  if (byTicker.size === 0) throw new Error("Finviz returned no ATR Matrix constituents");
  return [...byTicker.values()];
}

/** Fetch a single ticker's matrix row from Finviz (for the reverse lookup of a
 *  symbol that isn't in the S&P 500 / Nasdaq 100 universe). Returns null if the
 *  symbol is unknown or lacks the needed columns. */
export async function fetchTickerRow(ticker: string): Promise<FinvizMatrixRow | null> {
  const t = ticker.trim().toUpperCase();
  if (!t || !isEliteConfigured()) return null;
  const url = `https://elite.finviz.com/export?v=152&t=${encodeURIComponent(t)}&c=${MATRIX_COLUMNS}`;
  const rows = await fetchExportFromUrl(url, `atr-lookup:${t}`);
  for (const raw of rows) {
    const parsed = parseRow(raw, "LOOKUP");
    if (parsed && parsed.ticker === t) return parsed;
  }
  return null;
}
