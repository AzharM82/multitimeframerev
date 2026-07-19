/**
 * Constants ported from MarketMetrics `api/shared/constants.py`.
 *
 * Scope is limited to the five panels being migrated into the MTF portal:
 * key-metrics, stockbee-breadth, leading-industries, screeners and movers.
 * Sector-ETF / RRG / thematics / stage-analysis constants are deliberately
 * omitted — they belong to panels that are not part of this port.
 */

/** 19 key-metric row labels, in display order. */
export const KEY_METRIC_ROWS = [
  "Day Chg",
  "Open Chg",
  "Week",
  "Month",
  "Qtr",
  "Half Year",
  "Year",
  "Price to SMA10",
  "Price to SMA20",
  "Price to SMA50",
  "Price to SMA200",
  "EMA10>SMA20",
  "SMA20<SMA50",
  "SMA50<SMA200",
  "SMA20<SMA50<SMA200",
  "4% Up vs 4% Down",
  "New 20-Day Highs",
  "New 20-Day Lows",
  "Stocks",
] as const;

export type KeyMetricLabel = (typeof KEY_METRIC_ROWS)[number];

/** The 5 index groups that form the key-metrics columns. */
export const INDEX_GROUPS = ["NQ100", "SPY500", "DJIA", "RUS2000", "$1B+"] as const;

export type IndexGroup = (typeof INDEX_GROUPS)[number];

/** Base FinViz filter string per index group. */
export const INDEX_BASE_FILTERS: Record<string, string> = {
  NQ100: "geo_usa,idx_ndx",
  SPY500: "geo_usa,idx_sp500",
  DJIA: "geo_usa,idx_dji",
  RUS2000: "geo_usa,idx_rut",
  "$1B+": "cap_1to,geo_usa,sh_avgvol_o1000,sh_price_o1",
};

/**
 * `[upFilter, downFilter]` per metric label. `null` means the metric has no
 * counterpart in that direction (the New-20-Day rows are one-sided).
 */
export const KEY_METRIC_FILTERS: Record<string, [string | null, string | null]> = {
  "Day Chg": ["ta_change_u", "ta_change_d"],
  "Open Chg": ["ta_changeopen_u", "ta_changeopen_d"],
  Week: ["ta_perf_1wup", "ta_perf_1wdown"],
  Month: ["ta_perf_4wup", "ta_perf_4wdown"],
  Qtr: ["ta_perf_13wup", "ta_perf_13wdown"],
  "Half Year": ["ta_perf_26wup", "ta_perf_26wdown"],
  Year: ["ta_perf_ytdup", "ta_perf_ytddown"],
  "Price to SMA10": [
    "tad_0_sma:10:sma:d|abv:::1|close::close:d",
    "tad_0_sma:10:sma:d|blw:::1|close::close:d",
  ],
  "Price to SMA20": [
    "tad_0_sma:20:sma:d|abv:::1|close::close:d",
    "tad_0_sma:20:sma:d|blw:::1|close::close:d",
  ],
  "Price to SMA50": [
    "tad_0_sma:50:sma:d|abv:::1|close::close:d",
    "tad_0_sma:50:sma:d|blw:::1|close::close:d",
  ],
  "Price to SMA200": [
    "tad_0_sma:200:sma:d|abv:::1|close::close:d",
    "tad_0_sma:200:sma:d|blw:::1|close::close:d",
  ],
  "EMA10>SMA20": [
    "tad_0_close::close:d,tad_1_ema:10:ema:d|abv:::|sma:20:sma:d",
    "tad_0_close::close:d,tad_1_ema:10:ema:d|blw:::|sma:20:sma:d",
  ],
  "SMA20<SMA50": [
    "tad_0_sma:50:sma:d|blw:::1|sma:20:sma:d",
    "tad_0_sma:50:sma:d|abv:::1|sma:20:sma:d",
  ],
  "SMA50<SMA200": [
    "tad_0_sma:200:sma:d|blw:::1|sma:50:sma:d",
    "tad_0_sma:200:sma:d|abv:::1|sma:50:sma:d",
  ],
  "SMA20<SMA50<SMA200": [
    "tad_0_sma:200:sma:d|blw:::1|sma:50:sma:d,tad_1_sma:20:sma:d|blw:::|sma:50:sma:d",
    "tad_0_sma:200:sma:d|abv:::1|sma:50:sma:d,tad_1_sma:20:sma:d|abv:::|sma:50:sma:d",
  ],
  "4% Up vs 4% Down": ["ta_change_u4", "ta_change_d4"],
  "New 20-Day Highs": ["ta_highlow20d_nh", null],
  "New 20-Day Lows": ["ta_highlow20d_nl", null],
};

/**
 * Named FinViz Elite `export.ashx` URLs. Only the keys reachable from the five
 * ported panels are carried over; `auth=` is appended at request time.
 */
export const FINVIZ_EXPORT_URLS: Record<string, string> = {
  // ---- movers -----------------------------------------------------------
  "9m_movers":
    "https://elite.finviz.com/export.ashx?v=111&f=cap_1to,geo_usa,sh_curvol_9000tox,sh_price_o1,sh_relvol_1.25to",
  club97: "https://elite.finviz.com/export.ashx?v=111&f=cap_1to,geo_usa,sh_avgvol_o1000,sh_price_o1",
  "20pct_weekly_up":
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_perf_1w20o&o=-change&c=1,41,47,61,62,63,64,65",
  "20pct_weekly_down":
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_perf_1w20u&o=-change&c=1,41,47,61,62,63,64,65",
  "4pct_daily":
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_perf_4to-d&o=-change&c=1,47,61,62,63,64,65",

  // ---- screeners --------------------------------------------------------
  qulla_episodic:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,ta_gap_u10,sh_relvol_o2,sh_price_o1,sh_avgvol_o1000&o=-change&c=1,47,61,62,63,64,65",
  qulla_ps_large:
    "https://elite.finviz.com/export.ashx?v=141&f=cap_largeover,geo_usa,ta_perf_50to-4w&o=-change&c=1,47,61,62,63,64,65",
  qulla_ps_small:
    "https://elite.finviz.com/export.ashx?v=141&f=cap_to9,geo_usa,ta_perf_300to-4w,ta_perf2_100to-1w&ft=4&o=-change&c=1,47,61,62,63,64,65",
  qulla_breakouts:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_highlow52w_0to25-bhx,ta_perf_30to-4w,tad_0_close::close:d|abvpct::10:|sma:20:sma:d&o=-change&c=1,47,61,62,63,64,65",
  minervini:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_sma200_pa,tad_0_sma:150:sma:d|abv:::1|close::close:d,tad_1_sma:200:sma:d|abv:::1|close::close:d,tad_2_sma:200:sma:d|abv:::1|sma:150:sma:d,tad_3_sma:50:sma:d|abv:::|sma:150:sma:d,tad_4_sma:50:sma:d|abv:::|sma:200:sma:d,tad_5_sma:50:sma:d|abv:::1|close::close:d,tad_6_close::close:d|abvpct:30::|hilo:52:low:d,tad_7_close::close:d|blwpct::25:|hilo:52:high:d,tad_8_rsi:14:rsi:d|abveq:::|value:::70&o=-change&c=1,47,61,62,63,64,65",
  oneil:
    "https://elite.finviz.com/export.ashx?v=161&f=fa_epsyoy_o25,fa_epsyoy1_o25,fa_epsyoyttm_pos,fa_netmargin_pos,fa_roe_pos,geo_usa&o=-change&ft=2&c=1,32,40,47,61,62,63,64,65",

  // ---- group indicators (key metrics / leading industries / 97 club) -----
  ind_1b:
    "https://elite.finviz.com/export.ashx?v=141&f=cap_1to,geo_usa,sh_avgvol_o1000,sh_price_o1&o=-change&c=1,3,4,6,41,42,43,45,47,50,51,52,55,56,61,62,63,64,65",
  ind_1b_km:
    "https://elite.finviz.com/export.ashx?v=152&f=cap_1to,geo_usa,sh_avgvol_o1000,sh_price_o1&ft=4&o=-change&c=1,42,43,44,45,47,52,53,54,60,65,66",
  ind_9m:
    "https://elite.finviz.com/export.ashx?v=141&f=cap_1to,geo_usa,sh_curvol_9000tox,sh_price_o1,sh_relvol_1.25to&o=-change&c=1,3,4,6,41,42,43,45,47,50,51,52,55,56,61,62,63,64,65",
  ind_usa:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_price_o1,sh_avgvol_o1000&o=-change&c=1,3,4,6,41,42,43,44,45,47,50,51,52,55,56,61,62,63,64,65",
  ind_ndx:
    "https://elite.finviz.com/export.ashx?v=152&f=geo_usa,idx_ndx&ft=4&o=-change&c=1,42,43,44,45,47,52,53,54,60,65,66",
  ind_sp500:
    "https://elite.finviz.com/export.ashx?v=152&f=geo_usa,idx_sp500&ft=4&o=-change&c=1,42,43,44,45,47,52,53,54,60,65,66",
  ind_dji:
    "https://elite.finviz.com/export.ashx?v=152&f=geo_usa,idx_dji&ft=4&o=-change&c=1,42,43,44,45,47,52,53,54,60,65,66",
  ind_rut:
    "https://elite.finviz.com/export.ashx?v=152&f=geo_usa,idx_rut&ft=4&o=-change&c=1,42,43,44,45,47,52,53,54,60,65,66",
};

/**
 * Group-indicator key → list of `FINVIZ_EXPORT_URLS` keys, ported verbatim from
 * `data_fetcher.py:_GROUP_INDICATOR_URL_KEYS`.
 *
 * NOTE (faithful-port quirk): `compute_key_metrics_single_group` looks these up
 * as `ind_<INDEX_GROUPS entry>`, i.e. `ind_NQ100`, `ind_SPY500`, `ind_DJIA`,
 * `ind_RUS2000`, `ind_$1B+`. There is no `ind_SPY500` entry here — the map has
 * `ind_RSP` for the S&P universe instead. In the original Python this means the
 * SPY500 column gets no indicator rows and only its URL-scraped counts are
 * populated — measured as 8 of 19 rows filled versus 18 for every other group.
 *
 * FIXED at integration: `ind_SPY500` is aliased to the same `ind_sp500` export
 * the unused `ind_RSP` key points at. The original almost certainly intended
 * this — RSP is the equal-weight S&P ETF, not the index group name — and the
 * mismatch simply meant the lookup never hit. `ind_RSP` is left in place so the
 * map still mirrors the source.
 */
export const GROUP_INDICATOR_URL_KEYS: Record<string, string[]> = {
  "ind_$1B+": ["ind_1b_km"],
  ind_97_club: ["ind_1b"],
  ind_9m_movers: ["ind_9m"],
  ind_leading: ["ind_1b"],
  ind_USA: ["ind_usa"],
  ind_NQ100: ["ind_ndx"],
  ind_RSP: ["ind_sp500"],
  ind_SPY500: ["ind_sp500"],
  ind_DJIA: ["ind_dji"],
  ind_RUS2000: ["ind_rut"],
};

/** Stockbee Google Sheets gviz endpoints. */
export const MARKET_BREADTH_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1O6OhS7ciA8zwfycBfGPbP2fWJnR0pn2UUvFZVDP9jpE/gviz/tq?tqx=out:json";

/**
 * Metrics whose above/below counts cannot be derived from the indicator CSV and
 * are instead scraped as FinViz row counts. Source:
 * `calculations.py:_URL_BASED_METRICS`.
 */
export const URL_BASED_METRICS: ReadonlySet<string> = new Set([
  "Price to SMA10",
  "EMA10>SMA20",
  "SMA20<SMA50",
  "SMA50<SMA200",
  "SMA20<SMA50<SMA200",
  "4% Up vs 4% Down",
  "New 20-Day Highs",
  "New 20-Day Lows",
]);

/**
 * Python's `urllib.parse.quote(s, safe="")`. `encodeURIComponent` leaves
 * `!'()*` alone where Python percent-encodes them, so those are patched back in.
 * None of the current filter strings contain those characters, but the helper
 * keeps the two implementations byte-identical if new filters are added.
 */
function pyQuote(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the FinViz screener/export URL for one key-metric cell.
 *
 * Source: `constants.py:build_metric_screener_url`. Returns `null` when the
 * group or metric is unknown, or when the requested direction has no filter
 * (e.g. "below" for New 20-Day Highs).
 */
export function buildMetricScreenerUrl(
  indexKey: string,
  metricLabel: string,
  direction: "above" | "below",
  forExport = false,
): string | null {
  const base = INDEX_BASE_FILTERS[indexKey];
  const filters = KEY_METRIC_FILTERS[metricLabel];
  if (!base || !filters) return null;

  const [upF, downF] = filters;
  let filterStr: string;
  if (direction === "above" && upF) {
    filterStr = upF;
  } else if (direction === "below" && downF) {
    filterStr = downF;
  } else {
    return null;
  }

  const encoded = pyQuote(`${base},${filterStr}`);
  const ft = filterStr.includes("tad_") || filterStr.startsWith("ta_") ? "&ft=3" : "";
  const endpoint = forExport ? "export.ashx" : "screener.ashx";
  return `https://elite.finviz.com/${endpoint}?v=111&f=${encoded}${ft}`;
}
