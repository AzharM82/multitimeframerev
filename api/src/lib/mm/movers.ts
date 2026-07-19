/**
 * Movers panel (97 Club / 9M volume / 20% weekly / 4% daily), ported from
 * MarketMetrics `api/shared/calculations.py` (`compute_97_club`,
 * `compute_9m_movers`, `compute_20pct_weekly`, `compute_4pct_daily`,
 * `compute_movers`) and `api/shared/data_fetcher.py:fetch_20pct_weekly_from_urls`.
 */

import { FINVIZ_EXPORT_URLS } from "./constants.js";
import { findCsvCol, formatSignedPct, getCsvVal, isMissingNum, parseNum, parsePct, round } from "./csv.js";
import {
  FINVIZ_DELAY_MS,
  fetchExportFromUrl,
  fetchGroupIndicators,
  fetchIndustryMapFromOverview,
  fetchScreenerFromUrl,
  type ScreenerRow,
} from "./finviz.js";
import { percentileRank } from "../stats.js";

export interface ClubRow {
  ticker: string;
  price: number;
  change: string;
  week: number;
  month: number;
  industry: string;
  volume: number | null;
  rel_vol: number | null;
  atr_pct: number | null;
}

export interface WeeklyMoverRow {
  ticker: string;
  week: number;
  price: string;
  avg_vol: string;
  rel_vol: string;
  change: string;
  volume: string;
  atr_pct: number | null;
}

export type MoverType = "97club" | "9m_movers" | "20pct_weekly" | "4pct_daily";

/** 97 Club cutoff: a ticker must sit in the top 3% on all three horizons. */
const CLUB_97_CUTOFF = 0.97;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The 97 Club: tickers ranking >= 0.97 on day, week AND month change.
 *
 * Source: `calculations.py:compute_97_club`. Ranking is done by the
 * golden-vector-verified `percentileRank` — its averaged tie ranks are what
 * decide membership at the cutoff, so it must not be reimplemented here.
 * The industry label prefers the $1B+ overview map and falls back to whatever
 * the indicator export carried. Output is sorted by month change, descending.
 */
export async function compute97Club(): Promise<ClubRow[]> {
  const indicators = await fetchGroupIndicators("ind_97_club");
  if (indicators.length === 0) return [];

  const dayRanks = percentileRank(indicators.map((r) => r.day_chg));
  const weekRanks = percentileRank(indicators.map((r) => r.week_chg));
  const monthRanks = percentileRank(indicators.map((r) => r.month_chg));

  const industryMap = await fetchIndustryMapFromOverview();

  const rows: ClubRow[] = [];
  for (let i = 0; i < indicators.length; i += 1) {
    if (
      dayRanks[i] < CLUB_97_CUTOFF ||
      weekRanks[i] < CLUB_97_CUTOFF ||
      monthRanks[i] < CLUB_97_CUTOFF
    ) {
      continue;
    }
    const r = indicators[i];
    rows.push({
      ticker: r.ticker,
      price: r.close,
      change: formatSignedPct(r.day_chg),
      week: round(r.week_chg, 1),
      month: round(r.month_chg, 1),
      industry: industryMap[r.ticker] ?? r.industry,
      volume: r.volume,
      rel_vol: r.rel_volume ? round(r.rel_volume, 2) : null,
      atr_pct: r.atr_pct,
    });
  }

  // NaN months sort last, mirroring Python's `sort(key=..., reverse=True)`
  // leaving unorderable NaN in place rather than raising.
  rows.sort((a, b) => {
    const av = Number.isNaN(a.month) ? -Infinity : a.month;
    const bv = Number.isNaN(b.month) ? -Infinity : b.month;
    return bv - av;
  });

  return rows;
}

/** 9M+ current volume with relative volume >= 1.25. */
export async function compute9mMovers(): Promise<ScreenerRow[]> {
  return fetchScreenerFromUrl("9m_movers");
}

/** Up 4%+ on the day. */
export async function compute4pctDaily(): Promise<ScreenerRow[]> {
  return fetchScreenerFromUrl("4pct_daily");
}

/**
 * Up or down 20%+ over the past week, both directions merged.
 *
 * Source: `data_fetcher.py:fetch_20pct_weekly_from_urls`. Two exports are
 * fetched sequentially with a 2s gap (FinViz rate limiting), deduplicated by
 * ticker with the up-list winning, and finally sorted by **absolute** weekly
 * move so the biggest drops interleave with the biggest gains. A missing weekly
 * performance becomes 0.0 rather than being dropped.
 */
export async function compute20pctWeekly(): Promise<WeeklyMoverRow[]> {
  const rows: WeeklyMoverRow[] = [];
  const seen = new Set<string>();

  for (const urlKey of ["20pct_weekly_up", "20pct_weekly_down"]) {
    const url = FINVIZ_EXPORT_URLS[urlKey];
    if (!url) continue;

    await sleep(FINVIZ_DELAY_MS);
    const data = await fetchExportFromUrl(url, `20pct_weekly/${urlKey}`);
    if (data.length === 0) continue;

    const keys = Object.keys(data[0]);
    const tickerCol = findCsvCol(keys, [], "Ticker") ?? "Ticker";

    for (const row of data) {
      const t = String(row[tickerCol] ?? "").trim().toUpperCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);

      const weekRaw = parsePct(getCsvVal(row, "Performance (Week)", "Perf Week"));
      const week = isMissingNum(weekRaw) ? 0.0 : round(weekRaw, 1);

      const price = getCsvVal(row, "Price", "price");
      const change = getCsvVal(row, "Change", "change");
      const vol = getCsvVal(row, "Volume", "volume");
      const avgVol = getCsvVal(row, "Avg Volume", "Average Volume");
      let relVol = getCsvVal(row, "Rel Volume", "Relative Volume");

      if (!relVol && vol && avgVol) {
        const vNum = parseNum(vol);
        const aNum = parseNum(avgVol);
        if (vNum && aNum && aNum !== 0) relVol = (vNum / aNum).toFixed(2);
      }

      const atrVal = parseNum(getCsvVal(row, "ATR", "atr"));
      const priceNum = price ? parseNum(price) : null;
      const atrPct =
        atrVal && priceNum && priceNum !== 0 ? round((atrVal / priceNum) * 100, 2) : null;

      rows.push({
        ticker: t,
        week,
        price,
        avg_vol: avgVol,
        rel_vol: relVol,
        change,
        volume: vol,
        atr_pct: atrPct,
      });
    }
  }

  rows.sort((a, b) => Math.abs(b.week) - Math.abs(a.week));
  return rows;
}

/**
 * Dispatch by mover name. Unknown names fall back to the 97 Club, matching
 * `calculations.py:compute_movers`.
 */
export async function computeMovers(
  moverType: string,
): Promise<ClubRow[] | ScreenerRow[] | WeeklyMoverRow[]> {
  switch (moverType as MoverType) {
    case "9m_movers":
      return compute9mMovers();
    case "20pct_weekly":
      return compute20pctWeekly();
    case "4pct_daily":
      return compute4pctDaily();
    case "97club":
    default:
      return compute97Club();
  }
}
