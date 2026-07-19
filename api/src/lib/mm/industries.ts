/**
 * Leading Industries panel, ported from MarketMetrics
 * `api/shared/calculations.py:compute_leading_industries`.
 */

import { formatSignedPct, round } from "./csv.js";
import {
  fetchGroupIndicators,
  fetchIndustryMapFromOverview,
  type IndicatorRow,
} from "./finviz.js";
import { percentileRank, topPercentCount } from "../stats.js";

export interface LeadingIndustryTicker {
  ticker: string;
  change: string;
  week: number;
  month: number;
  atr_pct: number | null;
}

export interface LeadingIndustry {
  industry: string;
  /** Average combined RS of the industry's members, as a 0-100 percentage. */
  avg_rs: number;
  tickers: LeadingIndustryTicker[];
}

/** Members-per-industry shown in the panel. */
const TICKERS_PER_INDUSTRY = 4;

/**
 * Rank the universe, average each industry's relative strength, and return the
 * top 20% of industries with their four strongest members.
 *
 * The algorithm (from the Python):
 *  1. Backfill a missing/`"-"` industry from the $1B+ overview map, else
 *     "Unknown" — nothing is dropped for lacking an industry label.
 *  2. Percentile-rank week and month performance **across the whole universe**,
 *     not within an industry, then average the two ranks per ticker
 *     (`rs_combined`). Ranking is delegated to the golden-vector-verified
 *     `percentileRank`; its tie handling decides membership here.
 *  3. Average `rs_combined` per industry — an unweighted mean, so a two-stock
 *     industry can outrank a fifty-stock one.
 *  4. Keep `max(1, floor(n * 0.2))` industries (`topPercentCount`).
 *
 * `avg_rs` is reported as `round(avg * 100, 1)` to read as a percentile.
 */
export async function computeLeadingIndustries(): Promise<LeadingIndustry[]> {
  const indicators = await fetchGroupIndicators("ind_leading");
  if (indicators.length === 0) return [];

  const industryMap = await fetchIndustryMapFromOverview();

  // Step 1 — resolve an industry label for every row.
  for (const r of indicators) {
    if (!r.industry || r.industry === "-") {
      r.industry = industryMap[r.ticker] ?? "Unknown";
    }
    if (!r.industry) r.industry = "Unknown";
  }

  const filtered = indicators.filter((r) => r.industry.length > 0);
  if (filtered.length === 0) return [];

  // Step 2 — universe-wide percentile ranks.
  const weekRanks = percentileRank(filtered.map((r) => r.week_chg));
  const monthRanks = percentileRank(filtered.map((r) => r.month_chg));

  const scored = filtered.map((r, i) => ({
    row: r,
    rsCombined: (weekRanks[i] + monthRanks[i]) / 2,
  }));

  // Step 3 — unweighted mean of rs_combined per industry.
  const totals = new Map<string, { sum: number; count: number }>();
  for (const s of scored) {
    const key = s.row.industry;
    const entry = totals.get(key) ?? { sum: 0, count: 0 };
    entry.sum += s.rsCombined;
    entry.count += 1;
    totals.set(key, entry);
  }

  const industryRs = Array.from(totals, ([industry, v]) => ({
    industry,
    avgRs: v.count ? v.sum / v.count : 0,
  }));
  industryRs.sort((a, b) => b.avgRs - a.avgRs);

  // Step 4 — top 20%.
  const topIndustries = industryRs.slice(0, topPercentCount(industryRs.length));

  return topIndustries.map((item) => {
    const members = scored
      .filter((s) => s.row.industry === item.industry)
      .sort((a, b) => b.rsCombined - a.rsCombined)
      .slice(0, TICKERS_PER_INDUSTRY);

    return {
      industry: item.industry,
      avg_rs: round(item.avgRs * 100, 1),
      tickers: members.map((s) => ({
        ticker: s.row.ticker,
        change: formatSignedPct(s.row.day_chg),
        week: round(s.row.week_chg, 1),
        month: round(s.row.month_chg, 1),
        atr_pct: s.row.atr_pct,
      })),
    };
  });
}

/** Re-exported so integration code can type indicator inputs without reaching into `finviz.ts`. */
export type { IndicatorRow };
