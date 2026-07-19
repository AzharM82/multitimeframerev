/**
 * FinViz Elite client, ported from MarketMetrics `api/shared/finviz_elite.py`
 * and the fetch/normalise half of `api/shared/data_fetcher.py`.
 *
 * Differences from the Python original, on purpose:
 *  - TLS verification is NOT disabled. The Python used `ssl.CERT_NONE`; that is
 *    not carried over.
 *  - Global `fetch` (Node 20) replaces `urllib`. `fetch` follows redirects
 *    itself, so the explicit redirect chase is unnecessary; the login-page check
 *    still runs against the final `response.url`.
 *  - A missing `FINVIZ_API_KEY` throws instead of returning `[]`, so a
 *    misconfigured deployment fails loudly rather than rendering empty panels.
 */

import {
  FINVIZ_EXPORT_URLS,
  GROUP_INDICATOR_URL_KEYS,
} from "./constants.js";
import {
  findCsvCol,
  getCsvVal,
  isMissingNum,
  parseCsv,
  parseNum,
  parsePct,
  round,
  type CsvRow,
} from "./csv.js";

const ELITE_BASE = "https://elite.finviz.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** `data_fetcher.py:_FINVIZ_DELAY_SEC` — courtesy gap between quote requests. */
export const FINVIZ_DELAY_MS = 2_000;

export class FinvizConfigError extends Error {
  constructor() {
    super(
      "FINVIZ_API_KEY is not set. The MarketMetrics panels (key metrics, " +
        "leading industries, screeners, movers) all read from FinViz Elite and " +
        "cannot run without it.",
    );
    this.name = "FinvizConfigError";
  }
}

/** Throws `FinvizConfigError` when unset — see hard requirement 8. */
export function getApiKey(): string {
  const key = (process.env.FINVIZ_API_KEY ?? "").trim();
  if (!key) throw new FinvizConfigError();
  return key;
}

/** Non-throwing probe, for callers that want to degrade rather than fail. */
export function isEliteConfigured(): boolean {
  return (process.env.FINVIZ_API_KEY ?? "").trim().length > 0;
}

function addAuth(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}auth=${getApiKey()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchTextResult {
  status: number;
  url: string;
  text: string;
}

async function fetchText(url: string, timeoutMs = 60_000): Promise<FetchTextResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, url: res.url || url, text: await res.text() };
}

/**
 * Fetch a CSV export, retrying on 429 with the original 15s/30s/60s/120s
 * backoff. Source: `finviz_elite.py:fetch_export_from_url`.
 */
export async function fetchExportFromUrl(url: string, caller = ""): Promise<CsvRow[]> {
  const fullUrl = addAuth(url);
  const who = caller || "FinViz";

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let result: FetchTextResult;
    try {
      result = await fetchText(fullUrl);
    } catch (err: unknown) {
      console.warn(`[${who}] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    if (result.status === 429) {
      const wait = 2 ** attempt * 15_000;
      console.warn(`[${who}] 429 rate limit, waiting ${wait / 1000}s (attempt ${attempt + 1})`);
      await sleep(wait);
      continue;
    }

    if (/login/i.test(result.url)) {
      console.warn(`[${who}] got HTML/login page`);
      return [];
    }
    return parseCsv(result.text);
  }

  console.warn(`[${who}] failed after 4 retries (429)`);
  return [];
}

/** Alias kept for parity with `finviz_elite.py:fetch_csv_from_url`. */
export const fetchCsvFromUrl = fetchExportFromUrl;

/**
 * Row count for a screener URL — this is how the URL-based key metrics get
 * their above/below numbers. Source: `data_fetcher.py:fetch_metric_count`.
 */
export async function fetchMetricCount(
  url: string,
  caller = "",
  skipDelay = false,
): Promise<number> {
  if (!skipDelay) await sleep(FINVIZ_DELAY_MS);
  const data = await fetchCsvFromUrl(url, caller);
  return data.length;
}

/**
 * Single-ticker snapshot scraped out of `quote.ashx`.
 *
 * Source: `finviz_elite.py:fetch_elite_stock`. The page is parsed with the same
 * three regexes as the original (no HTML parser): rows carrying
 * `table-dark-row`, then `snapshot-td2` cells read pairwise as label/value.
 * The two special cases are preserved — a repeated "EPS next Y" becomes
 * "EPS growth next Y", and "Volatility" splits into week/month.
 */
export async function fetchEliteStock(ticker: string): Promise<Record<string, string> | null> {
  const params = new URLSearchParams({ t: ticker, auth: getApiKey() });
  let result: FetchTextResult;
  try {
    result = await fetchText(`${ELITE_BASE}/quote.ashx?${params.toString()}`, 30_000);
  } catch (err: unknown) {
    console.warn(`Elite quote ${ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (/login/i.test(result.url) || /sign in/i.test(result.text.slice(0, 2000))) return null;

  const data: Record<string, string> = { Ticker: ticker };

  const rowPattern = /<tr[^>]*class="[^"]*table-dark-row[^"]*"[^>]*>(.*?)<\/tr>/gis;
  const tagStrip = /<[^>]+>/g;

  for (const rowMatch of result.text.matchAll(rowPattern)) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    const tdPattern = /<td[^>]*class="[^"]*snapshot-td2[^"]*"[^>]*>(.*?)<\/td>/gis;
    for (const tdMatch of rowHtml.matchAll(tdPattern)) cells.push(tdMatch[1]);

    for (let i = 0; i + 1 < cells.length; i += 2) {
      const label = cells[i].replace(tagStrip, "").trim();
      const value = cells[i + 1].replace(tagStrip, "").trim();
      if (!label) continue;

      if (label === "EPS next Y" && "EPS next Y" in data) {
        data["EPS growth next Y"] = value;
        continue;
      }
      if (label === "Volatility") {
        const vols = value.split(/\s+/).filter(Boolean);
        data["Volatility (Week)"] = vols[0] ?? "";
        data["Volatility (Month)"] = vols.length >= 2 ? vols[1] : data["Volatility (Week)"];
        continue;
      }
      data[label] = value;
    }
  }

  return Object.keys(data).length > 1 ? data : null;
}

// ---------------------------------------------------------------------------
// Screener rows (data_fetcher.py:fetch_screener_from_url)
// ---------------------------------------------------------------------------

export interface ScreenerRow {
  ticker: string;
  price: string;
  change: string;
  volume: string;
  avg_vol: string;
  rel_vol: string;
  atr_pct: number | null;
  tag?: string;
  news?: string;
  news_url?: string;
}

/**
 * `_val` from `fetch_screener_from_url`: prefer the fuzzily-resolved column,
 * fall back to the explicit candidate list.
 */
function valFrom(row: CsvRow, col: string | null, ...fallbacks: string[]): string {
  if (col) {
    const v = row[col];
    if (v !== undefined && v !== null && v !== "" && v !== "-" && String(v).trim() !== "") {
      return String(v);
    }
  }
  return fallbacks.length > 0 ? getCsvVal(row, ...fallbacks) : "";
}

/**
 * Normalise a raw FinViz export into screener rows, deduplicated by ticker.
 * Source: `data_fetcher.py:fetch_screener_from_url` (fetch + cache stripped).
 */
export function normalizeScreenerRows(data: CsvRow[]): ScreenerRow[] {
  if (data.length === 0) return [];

  const keys = Object.keys(data[0]);
  const tickerCol =
    findCsvCol(keys, [], "Ticker") ?? findCsvCol(keys, ["ticker"]) ?? "Ticker";
  const priceCol = findCsvCol(keys, [], "Price") ?? findCsvCol(keys, ["price"]);
  const changeCol = findCsvCol(keys, [], "Change") ?? findCsvCol(keys, ["change"]);
  const volCol = findCsvCol(keys, [], "Volume") ?? findCsvCol(keys, ["volume"]);
  const avgVolCol =
    findCsvCol(keys, ["average", "vol"]) ?? findCsvCol(keys, ["avg", "vol"]);
  const relVolCol =
    findCsvCol(keys, ["relative", "vol"]) ?? findCsvCol(keys, ["rel", "vol"]);
  const atrCol =
    findCsvCol(keys, [], "ATR") ??
    findCsvCol(keys, ["atr"]) ??
    findCsvCol(keys, ["average", "true", "range"]);
  const newsCol = findCsvCol(keys, ["news", "title"]) ?? findCsvCol(keys, ["headline"]);
  const newsLinkCol =
    findCsvCol(keys, ["news", "link"]) ??
    findCsvCol(keys, ["link"]) ??
    findCsvCol(keys, ["url"]);

  const rows: ScreenerRow[] = [];
  const seen = new Set<string>();

  for (const row of data) {
    const t = String(row[tickerCol] ?? "").trim().toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);

    const price = valFrom(row, priceCol, "Price", "price", "Last", "Close");
    const change = valFrom(row, changeCol, "Change", "change");
    const vol = valFrom(row, volCol, "Volume", "volume");
    const avgVol = valFrom(row, avgVolCol, "Avg Volume", "Average Volume");
    let relVol = valFrom(row, relVolCol, "Rel Volume", "Relative Volume");

    if (!relVol && vol && avgVol) {
      const vNum = parseNum(vol);
      const aNum = parseNum(avgVol);
      if (vNum && aNum && aNum !== 0) relVol = (vNum / aNum).toFixed(2);
    }

    const atrVal = atrCol ? parseNum(valFrom(row, atrCol, "ATR", "atr")) : null;
    const priceNum = price ? parseNum(price) : null;
    const atrPct =
      atrVal && priceNum && priceNum !== 0 ? round((atrVal / priceNum) * 100, 2) : null;

    const newsVal = newsCol ? valFrom(row, newsCol) : "";
    const newsLinkVal = newsLinkCol ? valFrom(row, newsLinkCol) : "";
    const newsUrl = newsLinkVal ? String(newsLinkVal).trim() : "";

    const out: ScreenerRow = {
      ticker: t,
      price,
      change,
      volume: vol,
      avg_vol: avgVol,
      rel_vol: relVol,
      atr_pct: atrPct,
    };

    if (newsUrl) {
      out.news_url = newsUrl;
    } else if (newsVal) {
      const s = String(newsVal).trim();
      // Python `s.isdigit()`: reject bare short numbers (stray column indices).
      if (s && !(/^\d+$/.test(s) && s.length <= 4)) out.news = s.slice(0, 80);
    }

    rows.push(out);
  }

  return rows;
}

/** Fetch + normalise one named export URL. */
export async function fetchScreenerFromUrl(urlKey: string): Promise<ScreenerRow[]> {
  const url = FINVIZ_EXPORT_URLS[urlKey];
  if (!url) return [];
  return normalizeScreenerRows(await fetchExportFromUrl(url, urlKey));
}

// ---------------------------------------------------------------------------
// Group indicators (data_fetcher.py:_parse_group_indicators_rows)
// ---------------------------------------------------------------------------

export interface IndicatorRow {
  ticker: string;
  close: number;
  prev_close: number;
  open: number;
  day_chg: number;
  open_chg: number;
  /** Performance columns are `NaN` when the export omits them. */
  week_chg: number;
  month_chg: number;
  qtr_chg: number;
  half_chg: number;
  year_chg: number;
  sma10: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema10: number | null;
  atr: number | null;
  atr_pct: number | null;
  high_20: number | null;
  low_20: number | null;
  price_to_20_range: number;
  high_52w: number | null;
  low_52w: number | null;
  volume: number | null;
  avg_volume: number | null;
  rel_volume: number | null;
  new_20_high: boolean;
  new_20_low: boolean;
  industry: string;
  sector: string;
}

/**
 * Turn a FinViz indicator export into `IndicatorRow`s.
 *
 * Source: `data_fetcher.py:_parse_group_indicators_rows`. The non-obvious bit is
 * `_pct_to_sma`: FinViz `v=152` exports the moving averages as a *percentage
 * distance from price*, not as a level, so the absolute SMA is recovered as
 * `price / (1 + pct/100)`. A denominator inside ±0.01 is rejected as
 * numerically meaningless. SMA10/EMA10 fall back to SMA20 when absent.
 */
export function parseGroupIndicatorRows(
  data: CsvRow[],
  tickerSet: Set<string> | null,
): IndicatorRow[] {
  if (data.length === 0) return [];

  const keys = Object.keys(data[0]);
  const tickerCol =
    findCsvCol(keys, [], "Ticker") ?? findCsvCol(keys, ["ticker"]) ?? "Ticker";

  const rows: IndicatorRow[] = [];

  for (const row of data) {
    const t = String(row[tickerCol] ?? "").trim().toUpperCase();
    if (!t) continue;
    if (tickerSet && tickerSet.size > 0 && !tickerSet.has(t)) continue;

    const price = parseNum(getCsvVal(row, "Price", "price", "Last", "Close", "Last Price"));
    if (price === null || price <= 0) continue;

    let change = parsePct(getCsvVal(row, "Change", "change", "Change %"));
    if (isMissingNum(change)) change = 0;

    const openChgVal = parsePct(getCsvVal(row, "Change from Open", "Change from Open %"));
    const openChg = isMissingNum(openChgVal) ? change : openChgVal;

    const pct = (...alts: string[]): number => parsePct(getCsvVal(row, ...alts));

    const pctToSma = (p: number | null, base: number): number | null => {
      if (p === null || base <= 0) return null;
      const denom = 1 + p / 100;
      return Math.abs(denom) >= 0.01 ? base / denom : null;
    };

    const sma20Pct = parseNum(
      getCsvVal(row, "SMA20", "20-Day SMA", "20-Day SMA (Relative)", "20-Day Simple Moving Average"),
    );
    const sma50Pct = parseNum(
      getCsvVal(row, "SMA50", "50-Day SMA", "50-Day SMA (Relative)", "50-Day Simple Moving Average"),
    );
    const sma200Pct = parseNum(
      getCsvVal(row, "SMA200", "200-Day SMA", "200-Day SMA (Relative)", "200-Day Simple Moving Average"),
    );
    const sma10Pct = parseNum(getCsvVal(row, "SMA10", "10-Day SMA", "10-Day Simple Moving Average"));
    const ema10Pct = parseNum(
      getCsvVal(row, "EMA10", "10-Day EMA", "10-Day Exponential Moving Average"),
    );

    const sma20 = pctToSma(sma20Pct, price);
    const sma50 = pctToSma(sma50Pct, price);
    const sma200 = pctToSma(sma200Pct, price);
    const sma10 = sma10Pct !== null ? pctToSma(sma10Pct, price) : sma20;
    const ema10 = ema10Pct !== null ? pctToSma(ema10Pct, price) : sma20;

    const vol = parseNum(getCsvVal(row, "Volume", "volume"));
    const avgVol = parseNum(getCsvVal(row, "Avg Volume", "Average Volume"));
    let relVol = parseNum(getCsvVal(row, "Rel Volume", "Relative Volume"));
    if (relVol === null && vol && avgVol && avgVol !== 0) relVol = vol / avgVol;

    const atrVal = parseNum(getCsvVal(row, "ATR", "ATR (14)", "Average True Range"));
    const industry = String(getCsvVal(row, "Industry", "industry") ?? "").trim();
    const sector = String(getCsvVal(row, "Sector", "sector") ?? "").trim();

    rows.push({
      ticker: t,
      close: price,
      prev_close: change !== -100 ? price / (1 + change / 100) : price,
      open: price,
      day_chg: change,
      open_chg: openChg,
      week_chg: pct("Performance (Week)", "Perf Week", "Perf. Week", "1W"),
      month_chg: pct("Performance (Month)", "Perf Month", "Perf. Month", "1M"),
      qtr_chg: pct("Performance (Quarter)", "Perf Quart", "Perf Quarter", "3M"),
      half_chg: pct("Performance (Half Year)", "Perf Half", "Perf Half Y", "6M"),
      year_chg: pct("Performance (YTD)", "Performance (Year)", "Perf Year", "Perf YTD", "1Y"),
      sma10,
      sma20,
      sma50,
      sma200,
      ema10,
      atr: atrVal,
      atr_pct: atrVal && price ? round((atrVal / price) * 100, 2) : null,
      high_20: null,
      low_20: null,
      price_to_20_range: 50.0,
      high_52w: parseNum(getCsvVal(row, "52W High", "52-Week High")),
      low_52w: parseNum(getCsvVal(row, "52W Low", "52-Week Low")),
      volume: vol,
      avg_volume: avgVol !== null ? avgVol : vol,
      rel_volume: relVol,
      new_20_high: false,
      new_20_low: false,
      industry: industry || sector,
      sector,
    });
  }

  return rows;
}

/**
 * Fetch the indicator universe behind a group key (`ind_97_club`,
 * `ind_leading`, `ind_NQ100`, …). Source: `data_fetcher.py:fetch_group_indicators`.
 *
 * Returns `[]` for an unmapped key — see the note on
 * `GROUP_INDICATOR_URL_KEYS` about `ind_SPY500`.
 */
export async function fetchGroupIndicators(
  groupKey: string,
  tickers: string[] = [],
): Promise<IndicatorRow[]> {
  const urlKeys = GROUP_INDICATOR_URL_KEYS[groupKey];
  if (!urlKeys) return [];

  const tickerSet = tickers.length > 0 ? new Set(tickers.map((t) => t.toUpperCase())) : null;
  const allRows: IndicatorRow[] = [];
  const seen = new Set<string>();

  for (const urlKey of urlKeys) {
    const url = FINVIZ_EXPORT_URLS[urlKey];
    if (!url) continue;
    const data = await fetchExportFromUrl(url, `group_indicators/${urlKey}`);
    for (const r of parseGroupIndicatorRows(data, tickerSet)) {
      if (!seen.has(r.ticker)) {
        seen.add(r.ticker);
        allRows.push(r);
      }
    }
  }

  return allRows;
}

/**
 * `ticker → industry` from the broad $1B+ overview export, used to backfill the
 * industry label when the indicator export omits it.
 * Source: `data_fetcher.py:fetch_industry_map_from_overview`.
 */
export async function fetchIndustryMapFromOverview(): Promise<Record<string, string>> {
  const url = FINVIZ_EXPORT_URLS["club97"];
  if (!url) return {};

  const data = await fetchExportFromUrl(url, "club97");
  const industryMap: Record<string, string> = {};

  for (const row of data) {
    const t = String(getCsvVal(row, "Ticker", "ticker") ?? "").trim().toUpperCase();
    if (!t) continue;
    const ind = String(getCsvVal(row, "Industry", "industry") ?? "").trim();
    const sec = String(getCsvVal(row, "Sector", "sector") ?? "").trim();
    industryMap[t] = ind || sec || "";
  }

  return industryMap;
}
