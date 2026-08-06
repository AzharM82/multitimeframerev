/**
 * FinViz Elite sources for the Sector Desk, kept separate from the shared
 * `constants.ts` (which the Metrics panels depend on) to keep this feature's
 * URL surface self-contained and low-risk to change.
 *
 * IMPORTANT — column set: these all use view `v=141` (the "Performance" export),
 * which returns Ticker · Performance(Week..10Y) · Volatility(Week/Month) ·
 * Average Volume · Relative Volume · Price · Change · Volume. That is the ONLY
 * built-in view that carries real-time Volume + Relative Volume together with
 * Change and Price — the `v=152` technical view the plan first assumed has NO
 * volume/rel-vol/sector columns (verified empirically 2026-07-29). Sector and
 * index membership come from the `sec_*` / `idx_*` FILTERS, not a column, so no
 * sector column is needed. `parseGroupIndicatorRows` reads all of these by name.
 *
 * Liquidity floor `sh_avgvol_o1000` (avg vol > 1M) + `sh_price_o1` (price > $1)
 * keeps the universe to tradeable names. `o=-change` sorts by day change desc.
 */

const ELITE_EXPORT = "https://elite.finviz.com/export.ashx";
const V141 = "v=141";
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
  return `${ELITE_EXPORT}?${V141}&f=geo_usa,sec_${slug},${LIQUID}&o=-change`;
}

/** One export covering all 11 SPDR sector ETFs (the group anchors). */
export function sectorEtfExportUrl(): string {
  const tickers = SECTORS.map((s) => s.etf).join(",");
  return `${ELITE_EXPORT}?${V141}&t=${tickers}`;
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
  return `${ELITE_EXPORT}?${V141}&f=geo_usa,idx_${slug},${LIQUID}&o=-change`;
}
