/**
 * ATR Matrix universe — pulls the swing-scan candidate list from a Finviz Elite
 * screener. Finviz is the *screen* (which tickers + metadata); price history for
 * the extension math comes from Polygon (lib/polygon.ts).
 *
 * The screener filters live in a single URL (overridable via ATR_SCREENER_URL).
 * We convert the screener page URL to the export.ashx endpoint and let
 * finvizElite.fetchExportFromUrl append the auth token server-side. Columns are
 * mapped by header NAME (not position) so Finviz id/order drift can't silently
 * corrupt fields.
 */

import { fetchExportFromUrl, isEliteConfigured } from "./finvizElite.js";

// Default = the swing screener supplied by the user:
//   mid-cap+, USA, stocks only, avg vol > 750K, optionable, price > $10,
//   ATR > 1.5, SMA20 > SMA50 > SMA200 (uptrend stack), weekly volatility > 3%.
const DEFAULT_SCREENER_URL =
  "https://elite.finviz.com/screener?v=151&f=cap_midover,geo_usa,ind_stocksonly,sh_avgvol_o750,sh_opt_option,sh_price_o10,ta_averagetruerange_o1.5,ta_sma20_sa50,ta_sma50_sa200,ta_volatility_wo3&ft=4&o=-changeopen";

// Finviz export column ids → request a set that carries the metadata we render.
// Header-name mapping below tolerates id drift; price/bars come from Polygon.
// v=111 (Overview) supplies: No · Ticker · Company · Sector · Industry · Country
// · Market Cap · P/E · Price · Change · Volume.
const EXPORT_VIEW = "111";
const EXPORT_COLUMNS = "0,1,2,3,4,5,6";

// Finviz CSV header name → internal field name.
const COLUMN_MAP: Record<string, keyof FinvizRow> = {
  Ticker: "ticker",
  Company: "company",
  Sector: "sector",
  Industry: "industry",
  Country: "country",
  "Market Cap": "marketCapText",
};

export interface FinvizRow {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  country: string;
  marketCapText: string;
  marketCap: number; // dollars
}

/** Finviz market cap like '1.23B' / '950.00M' / '2.1T' → dollars. */
export function parseMarketCap(text: string): number {
  if (!text) return 0;
  const t = text.trim().toUpperCase().replace(/,/g, "");
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const last = t[t.length - 1];
  if (last in mult) {
    const n = parseFloat(t.slice(0, -1));
    return Number.isFinite(n) ? n * mult[last] : 0;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a Finviz screener page URL into the CSV export URL.
 *
 * Note the endpoint is `/export` (not the old `/export.ashx`, which now
 * 301-redirects and yields an empty body to non-redirect-following clients),
 * and filter/column lists must use LITERAL commas — Finviz rejects the
 * percent-encoded `%2C` form, so we assemble the query manually rather than via
 * URLSearchParams.
 */
export function toExportUrl(screenerUrl: string): string {
  const u = new URL(screenerUrl);
  const f = u.searchParams.get("f") ?? ""; // decoded → literal commas
  const ft = u.searchParams.get("ft") ?? "4";
  const o = u.searchParams.get("o") ?? "";
  const parts = [`v=${EXPORT_VIEW}`];
  if (f) parts.push(`f=${f}`);
  if (ft) parts.push(`ft=${ft}`);
  if (o) parts.push(`o=${o}`);
  parts.push(`c=${EXPORT_COLUMNS}`);
  return `https://elite.finviz.com/export?${parts.join("&")}`;
}

/**
 * Pull the universe. Returns a map keyed by ticker so downstream code can attach
 * metadata after computing per-ticker metrics. Throws if Finviz is unconfigured
 * or returns nothing (so the timer surfaces the failure instead of writing an
 * empty snapshot).
 */
export async function pullUniverse(): Promise<Map<string, FinvizRow>> {
  if (!isEliteConfigured()) {
    throw new Error("FINVIZ_API_KEY is not set — cannot pull ATR Matrix universe");
  }
  const url = toExportUrl(process.env.ATR_SCREENER_URL || DEFAULT_SCREENER_URL);
  const rows = await fetchExportFromUrl(url, "ATRMatrix");
  if (rows.length === 0) {
    throw new Error("Finviz returned no rows for the ATR Matrix screener");
  }

  const out = new Map<string, FinvizRow>();
  for (const raw of rows) {
    const rec: Partial<FinvizRow> = {};
    for (const [header, value] of Object.entries(raw)) {
      const key = COLUMN_MAP[header.trim()];
      if (key) (rec as Record<string, string>)[key] = (value ?? "").trim();
    }
    const ticker = (rec.ticker ?? "").toUpperCase();
    if (!ticker) continue;
    out.set(ticker, {
      ticker,
      company: rec.company ?? "",
      sector: rec.sector ?? "",
      industry: rec.industry ?? "",
      country: rec.country ?? "",
      marketCapText: rec.marketCapText ?? "",
      marketCap: parseMarketCap(rec.marketCapText ?? ""),
    });
  }
  return out;
}
