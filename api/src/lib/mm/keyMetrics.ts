/**
 * Key Metrics panel (19 rows x 5 index groups), ported from MarketMetrics
 * `api/shared/calculations.py` (`_above_below`,
 * `compute_key_metrics_for_group`, `compute_key_metrics_single_group`,
 * `compute_all_key_metrics`).
 */

import {
  buildMetricScreenerUrl,
  INDEX_GROUPS,
  KEY_METRIC_ROWS,
  URL_BASED_METRICS,
} from "./constants.js";
import { isMissingNum, round } from "./csv.js";
import { fetchGroupIndicators, fetchMetricCount, type IndicatorRow } from "./finviz.js";

export interface KeyMetricRow {
  label: string;
  above: number;
  below: number;
  pct: number;
}

export interface KeyMetricGroup {
  group: string;
  rows: KeyMetricRow[];
  labels: readonly string[];
}

export interface KeyMetricsPayload {
  groups: Record<string, KeyMetricGroup>;
  labels: readonly string[];
}

/**
 * Which indicator field(s) each non-URL metric reads. A single string is a
 * "> 0?" test; a pair is a "price > moving average?" test.
 * Source: `calculations.py:_above_below:col_map`.
 */
type Mapping = keyof IndicatorRow | [keyof IndicatorRow, keyof IndicatorRow];

const COL_MAP: Record<string, Mapping> = {
  "Day Chg": "day_chg",
  "Open Chg": "open_chg",
  Week: "week_chg",
  Month: "month_chg",
  Qtr: "qtr_chg",
  "Half Year": "half_chg",
  Year: "year_chg",
  "Price to SMA10": ["close", "sma10"],
  "Price to SMA20": ["close", "sma20"],
  "Price to SMA50": ["close", "sma50"],
  "Price to SMA200": ["close", "sma200"],
};

function numeric(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Above/below counts for one metric.
 *
 * Note the tie rule from the original: a value of exactly 0 (or price exactly
 * equal to the SMA) counts as *below*, since the test is a strict `>`. Missing
 * readings are skipped entirely rather than counted on either side, so `above +
 * below` can be smaller than the universe.
 *
 * Metrics absent from `COL_MAP` (i.e. the URL-based ones, plus "Stocks") return
 * zeros — faithfully including "Stocks", which the Python never populates.
 */
export function aboveBelow(
  indicators: IndicatorRow[],
  metricLabel: string,
): Omit<KeyMetricRow, "label"> {
  const mapping = COL_MAP[metricLabel];
  if (mapping === undefined) return { above: 0, below: 0, pct: 0 };

  let above = 0;
  let below = 0;

  if (Array.isArray(mapping)) {
    const [priceCol, smaCol] = mapping;
    for (const r of indicators) {
      const p = numeric(r[priceCol]);
      const s = numeric(r[smaCol]);
      if (p === null || s === null || isMissingNum(p) || isMissingNum(s)) continue;
      if (p > s) above += 1;
      else below += 1;
    }
  } else {
    for (const r of indicators) {
      const v = numeric(r[mapping]);
      if (v === null || isMissingNum(v)) continue;
      if (v > 0) above += 1;
      else below += 1;
    }
  }

  const total = above + below;
  return { above, below, pct: total ? round((above / total) * 100, 1) : 0 };
}

/**
 * The 19 rows for one group, computed purely from an indicator list. URL-based
 * rows are left at zero here and filled in by `computeKeyMetricsSingleGroup`.
 * Source: `calculations.py:compute_key_metrics_for_group`.
 */
export function computeKeyMetricsForGroup(indicators: IndicatorRow[]): KeyMetricRow[] {
  return KEY_METRIC_ROWS.map((label) =>
    URL_BASED_METRICS.has(label)
      ? { label, above: 0, below: 0, pct: 0 }
      : { label, ...aboveBelow(indicators, label) },
  );
}

/**
 * Full key-metric column for one index group: indicator-derived rows plus the
 * eight rows whose counts have to be scraped as FinViz result-set sizes.
 *
 * Source: `calculations.py:compute_key_metrics_single_group`. Requests are
 * sequential and each `fetchMetricCount` sleeps 2s first — that pacing is what
 * keeps FinViz from 429-ing the batch, so do not parallelise it.
 *
 * The New-20-Day rows are one-sided: highs land in `above`, lows in `below`, and
 * `pct` stays 0 for both.
 */
export async function computeKeyMetricsSingleGroup(name: string): Promise<KeyMetricGroup> {
  const indicators = await fetchGroupIndicators(`ind_${name}`);
  const rows = computeKeyMetricsForGroup(indicators);

  for (const row of rows) {
    const { label } = row;
    if (!URL_BASED_METRICS.has(label)) continue;

    if (label === "New 20-Day Highs" || label === "New 20-Day Lows") {
      const url = buildMetricScreenerUrl(name, label, "above", true);
      const count = url ? await fetchMetricCount(url, `km_${name}_${label}`) : 0;
      if (label === "New 20-Day Highs") row.above = count;
      else row.below = count;
      continue;
    }

    const urlUp = buildMetricScreenerUrl(name, label, "above", true);
    const urlDn = buildMetricScreenerUrl(name, label, "below", true);
    const above = urlUp ? await fetchMetricCount(urlUp, `km_${name}_${label}_above`) : 0;
    const below = urlDn ? await fetchMetricCount(urlDn, `km_${name}_${label}_below`) : 0;
    row.above = above;
    row.below = below;
    const total = above + below;
    row.pct = total ? round((above / total) * 100, 1) : 0;
  }

  return { group: name, rows, labels: KEY_METRIC_ROWS };
}

/**
 * All five index groups. Sequential for the same rate-limit reason as above.
 * Source: `calculations.py:compute_all_key_metrics`.
 */
export async function computeAllKeyMetrics(): Promise<KeyMetricsPayload> {
  const groups: Record<string, KeyMetricGroup> = {};
  for (const name of INDEX_GROUPS) {
    groups[name] = await computeKeyMetricsSingleGroup(name);
  }
  return { groups, labels: KEY_METRIC_ROWS };
}
