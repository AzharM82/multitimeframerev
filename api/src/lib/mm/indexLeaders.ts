/**
 * Index Leaders panel compute (`index-leaders`).
 *
 * Top-3 high-volume gainers per major index (Dow / S&P 500 / Nasdaq 100 /
 * Russell 2000). Same real-time FinViz Elite source + liquidity floor as the
 * Sector Desk. No options data.
 *
 * 4 paced exports (~8s). Cron-warmed ~10–15 min in-hours (index leadership
 * moves slower than intraday sector rotation).
 */

import { fetchExportFromUrl, parseGroupIndicatorRows, FINVIZ_DELAY_MS } from "./finviz.js";
import { INDEXES, indexExportUrl, type IndexDef } from "./deskSources.js";

export interface IndexLeader {
  ticker: string;
  chg: number; // day change %
  volume: number;
  relVol: number;
  close: number;
  dollarVol: number; // close × volume
}

export interface IndexBlock {
  key: string;
  label: string;
  memberCount: number;
  leaders: IndexLeader[]; // top-3 gainers
}

export interface MmIndexLeadersData {
  generatedEt: string;
  indices: IndexBlock[];
}

const TOP_N = 3;

function etStamp(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function computeIndex(def: IndexDef): Promise<IndexBlock> {
  const data = await fetchExportFromUrl(indexExportUrl(def.slug), `index-leaders/${def.slug}`);
  const members = parseGroupIndicatorRows(data, null);

  const leaders: IndexLeader[] = members
    .map((m) => ({
      ticker: m.ticker,
      chg: m.day_chg,
      volume: m.volume ?? 0,
      relVol: m.rel_volume ?? 0,
      close: m.close,
      dollarVol: (m.volume ?? 0) * m.close,
    }))
    // Universe is already liquid-filtered by the FinViz query; sort by day gain.
    .sort((a, b) => b.chg - a.chg)
    .slice(0, TOP_N);

  return {
    key: def.key,
    label: def.label,
    memberCount: members.length,
    leaders,
  };
}

export async function computeIndexLeaders(): Promise<MmIndexLeadersData> {
  const indices: IndexBlock[] = [];
  for (const def of INDEXES) {
    await sleep(FINVIZ_DELAY_MS);
    indices.push(await computeIndex(def));
  }
  return { generatedEt: etStamp(), indices };
}
