/**
 * Screeners panel (Qullamaggie / Minervini / CANSLIM), ported from
 * MarketMetrics `api/shared/screeners.py` plus
 * `api/shared/data_fetcher.py:fetch_oneil_from_url`.
 *
 * Note this file deliberately does NOT collide with the existing
 * `api/src/lib/screeners.ts` — it is the MarketMetrics port, namespaced under
 * `lib/mm/`.
 */

import { FINVIZ_EXPORT_URLS } from "./constants.js";
import { findCsvCol, getCsvVal, parseNum, round } from "./csv.js";
import { fetchExportFromUrl, fetchScreenerFromUrl, type ScreenerRow } from "./finviz.js";

export type ScreenerType =
  | "qullamaggie"
  | "episodic_pivot"
  | "parabolic_short"
  | "breakouts"
  | "minervini"
  | "oneil";

export interface OneilRow {
  ticker: string;
  price: string;
  avg_vol: string;
  rel_vol: string;
  change: string;
  volume: string;
  atr_pct: number | null;
  roe: number | null;
  net_margin: number | null;
}

/** Episodic pivots: gap up 10%+ on 2x relative volume. Tagged `EP`. */
export async function episodicPivotScreener(): Promise<ScreenerRow[]> {
  const rows = await fetchScreenerFromUrl("qulla_episodic");
  return rows.map((r) => ({ ...r, tag: "EP" }));
}

/**
 * Parabolic shorts: the large-cap and small-cap lists merged, first occurrence
 * winning on a duplicate ticker. Tagged `PS`.
 */
export async function parabolicShortScreener(): Promise<ScreenerRow[]> {
  const psLarge = await fetchScreenerFromUrl("qulla_ps_large");
  const psSmall = await fetchScreenerFromUrl("qulla_ps_small");

  const seen = new Set<string>();
  const merged: ScreenerRow[] = [];
  for (const r of [...psLarge, ...psSmall]) {
    if (seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    merged.push({ ...r, tag: "PS" });
  }
  return merged;
}

/** Breakouts: near 52W high, 30%+ 4-week perf, 10%+ above SMA20. Tagged `BO`. */
export async function breakoutsScreener(): Promise<ScreenerRow[]> {
  const rows = await fetchScreenerFromUrl("qulla_breakouts");
  return rows.map((r) => ({ ...r, tag: "BO" }));
}

/**
 * The merged Qullamaggie list: EP + PS + BO, deduplicated by ticker.
 *
 * Source: `screeners.py:qullamaggie_screener`. A ticker appearing in more than
 * one sub-screen keeps the *first* screen's row data and accumulates the other
 * tags into a comma-joined string (e.g. `"EP,BO"`) — the tag is appended only
 * when it is not already a substring of the existing tag.
 */
export async function qullamaggieScreener(): Promise<ScreenerRow[]> {
  const ep = await episodicPivotScreener();
  const ps = await parabolicShortScreener();
  const bo = await breakoutsScreener();

  const seen = new Map<string, ScreenerRow>();
  for (const r of [...ep, ...ps, ...bo]) {
    const t = r.ticker;
    const existing = seen.get(t);
    if (existing) {
      const existingTag = existing.tag ?? "";
      const newTag = r.tag ?? "";
      if (newTag && !existingTag.includes(newTag)) {
        existing.tag = existingTag ? `${existingTag},${newTag}` : newTag;
      }
    } else {
      seen.set(t, { ...r });
    }
  }
  return Array.from(seen.values());
}

/** Minervini trend template — the whole test lives in the FinViz filter string. */
export async function minerviniScreener(): Promise<ScreenerRow[]> {
  return fetchScreenerFromUrl("minervini");
}

/**
 * `_pct_val` from `data_fetcher.py:fetch_oneil_from_url` — a stricter parser
 * than `parseNum`: no K/M/B suffixes, and both `-` and an em dash (U+2014) mean
 * "no value".
 */
function pctVal(val: string | null | undefined): number | null {
  if (val === null || val === undefined || val === "") return null;
  const t = String(val).trim();
  if (t === "-" || t === "—") return null;
  const cleaned = t.replace(/%/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return cleaned !== "" && Number.isFinite(n) ? n : null;
}

/**
 * O'Neil / CANSLIM: EPS growth + margins + ROE.
 *
 * Source: `data_fetcher.py:fetch_oneil_from_url`. The FinViz filter does the
 * growth screening; the extra quality gate applied here is
 * `ROE + net margin >= 25`, with a **missing value treated as 0** (Python's
 * `(roe_v or 0) + (margin_v or 0)`) — so a stock with no reported ROE must
 * clear 25 on margin alone.
 */
export async function oneilScreener(): Promise<OneilRow[]> {
  const url = FINVIZ_EXPORT_URLS["oneil"];
  if (!url) return [];

  const data = await fetchExportFromUrl(url, "oneil");
  if (data.length === 0) return [];

  const keys = Object.keys(data[0]);
  const roeCol = findCsvCol(keys, ["roe"]) ?? findCsvCol(keys, ["return", "equity"]);
  const marginCol = findCsvCol(keys, ["net", "margin"]) ?? findCsvCol(keys, ["profit", "margin"]);

  const rows: OneilRow[] = [];

  for (const row of data) {
    const t = String(getCsvVal(row, "Ticker", "ticker") ?? "").trim().toUpperCase();
    if (!t) continue;

    const roeV = pctVal(roeCol ? row[roeCol] : getCsvVal(row, "ROE", "roe"));
    const marginV = pctVal(
      marginCol ? row[marginCol] : getCsvVal(row, "Net Profit Margin", "Profit Margin"),
    );
    if ((roeV ?? 0) + (marginV ?? 0) < 25) continue;

    const price = getCsvVal(row, "Price", "price");
    const change = getCsvVal(row, "Change", "change");
    const vol = getCsvVal(row, "Volume", "volume");
    const avgVol = getCsvVal(row, "Avg Volume", "Average Volume");
    const relVol = getCsvVal(row, "Rel Volume", "Relative Volume");

    const atrVal = parseNum(getCsvVal(row, "ATR", "atr"));
    const priceNum = price ? parseNum(price) : null;
    const atrPct =
      atrVal && priceNum && priceNum !== 0 ? round((atrVal / priceNum) * 100, 2) : null;

    rows.push({
      ticker: t,
      price,
      avg_vol: avgVol,
      rel_vol: relVol,
      change,
      volume: vol,
      atr_pct: atrPct,
      roe: roeV,
      net_margin: marginV,
    });
  }

  return rows;
}

/**
 * Dispatch by screener name. Unknown names fall back to Qullamaggie, matching
 * `screeners.py:run_screener`.
 */
export async function runScreener(screenerType: string): Promise<ScreenerRow[] | OneilRow[]> {
  switch (screenerType as ScreenerType) {
    case "episodic_pivot":
      return episodicPivotScreener();
    case "parabolic_short":
      return parabolicShortScreener();
    case "breakouts":
      return breakoutsScreener();
    case "minervini":
      return minerviniScreener();
    case "oneil":
      return oneilScreener();
    case "qullamaggie":
    default:
      return qullamaggieScreener();
  }
}

export type { ScreenerRow };
