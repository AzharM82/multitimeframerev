/**
 * FinViz Elite sources for the Sector Desk, kept separate from the shared
 * `constants.ts` (which the Metrics panels depend on) to keep this feature's
 * URL surface self-contained and low-risk to change.
 *
 * IMPORTANT — column set: view `v=152` with an EXPLICIT `c=` column list. The
 * built-in `v=152`/`v=141` defaults don't carry everything at once, but v=152
 * DOES honor custom column IDs (verified 2026-08-06), so one export delivers:
 *   c=1  Ticker · 53 SMA50 (dist %) · 54 SMA200 (dist %) · 60 Change from Open
 *      · 63 Average Volume · 64 Relative Volume · 65 Price · 66 Change · 67 Volume
 * The SMA columns are the % distance of price from that SMA — exactly the
 * "how far from the MA" the desk shows. `parseGroupIndicatorRows` reads all of
 * these by name (Change, Change from Open, Price, Volume, Relative Volume, and
 * the SMA columns → recovered levels). EMA10/20 and the 5-day (65-bar 30-min
 * SMA) are NOT FinViz columns — those come from Polygon daily bars + Alpaca IEX
 * 30-min bars in `maEnrich.ts`.
 *
 * Sector/index membership comes from the `sec_*` / `idx_*` FILTERS. Liquidity
 * floor `sh_avgvol_o1000` (avg vol > 1M) + `sh_price_o1` (price > $1). `o=-change`
 * sorts by day change desc.
 */

const ELITE_EXPORT = "https://elite.finviz.com/export.ashx";
const V152 = "v=152";
/** Ticker, SMA50 dist, SMA200 dist, ChgFromOpen, AvgVol, RelVol, Price, Change, Volume. */
const COLS = "c=1,53,54,60,63,64,65,66,67";
const LIQUID = "sh_avgvol_o1000,sh_price_o1";

export interface SectorDef {
  /** Stable key used in the payload + UI. */
  key: string;
  /** Display label (matches FinViz's own sector name). */
  label: string;
  /** FinViz `sec_*` filter slug (no `sec_` prefix). */
  slug: string;
  /** SPDR sector ETF used as the group-move + rvol anchor. */
  etf: string;
}

/** The 11 FinViz sectors (FinViz assignment, not GICS — intentional per spec). */
export const SECTORS: SectorDef[] = [
  { key: "materials", label: "Basic Materials", slug: "basicmaterials", etf: "XLB" },
  { key: "communication", label: "Communication Services", slug: "communicationservices", etf: "XLC" },
  { key: "cyclical", label: "Consumer Cyclical", slug: "consumercyclical", etf: "XLY" },
  { key: "defensive", label: "Consumer Defensive", slug: "consumerdefensive", etf: "XLP" },
  { key: "energy", label: "Energy", slug: "energy", etf: "XLE" },
  { key: "financial", label: "Financial", slug: "financial", etf: "XLF" },
  { key: "healthcare", label: "Healthcare", slug: "healthcare", etf: "XLV" },
  { key: "industrials", label: "Industrials", slug: "industrials", etf: "XLI" },
  { key: "realestate", label: "Real Estate", slug: "realestate", etf: "XLRE" },
  { key: "technology", label: "Technology", slug: "technology", etf: "XLK" },
  { key: "utilities", label: "Utilities", slug: "utilities", etf: "XLU" },
];

/** Members of one sector, liquid + sorted by day change. */
export function sectorExportUrl(slug: string): string {
  return `${ELITE_EXPORT}?${V152}&f=geo_usa,sec_${slug},${LIQUID}&o=-change&${COLS}`;
}

/** One export covering all 11 SPDR sector ETFs (the group anchors). */
export function sectorEtfExportUrl(): string {
  const tickers = SECTORS.map((s) => s.etf).join(",");
  return `${ELITE_EXPORT}?${V152}&t=${tickers}&${COLS}`;
}

export interface IndexDef {
  key: string;
  label: string;
  /** FinViz `idx_*` filter slug (no `idx_` prefix). */
  slug: string;
}

/** The four major indexes for the "top-3 high-volume leaders" section. */
export const INDEXES: IndexDef[] = [
  { key: "dji", label: "Dow 30", slug: "dji" },
  { key: "sp500", label: "S&P 500", slug: "sp500" },
  { key: "ndx", label: "Nasdaq 100", slug: "ndx" },
  { key: "rut", label: "Russell 2000", slug: "rut" },
];

/** Liquid members of one index, sorted by day change desc. */
export function indexExportUrl(slug: string): string {
  return `${ELITE_EXPORT}?${V152}&f=geo_usa,idx_${slug},${LIQUID}&o=-change&${COLS}`;
}
