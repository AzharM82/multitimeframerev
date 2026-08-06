/**
 * Sector Desk panel compute (`sector-desk`).
 *
 * Answers "which sector group is running, and which liquid stocks inside it are
 * running with it." Pure stock signals only — move, $-liquidity, relative
 * volume, breadth. No options data anywhere (the operator picks their own
 * options off the LONG/SHORT direction).
 *
 * Data: FinViz Elite, real-time tier. One export per sector (11) plus one for
 * the 11 SPDR sector ETFs = 12 paced calls (~24s with the 2s courtesy gap),
 * comfortably inside the function timeout. Cron-warmed ~1–2 min in-hours.
 */

import { fetchExportFromUrl, parseGroupIndicatorRows, FINVIZ_DELAY_MS } from "./finviz.js";
import { SECTORS, sectorExportUrl, sectorEtfExportUrl, type SectorDef } from "./deskSources.js";
import {
  groupStrength,
  routeRegime,
  rankStocks,
  TUNING,
  type Direction,
  type Regime,
  type RankedStock,
  type RegimeGroupLite,
} from "../scoring.js";

export interface DeskGroup {
  key: string;
  sector: string; // display label
  etf: string;
  etfMove: number; // ETF day change %
  etfRvol: number; // ETF relative volume ×
  breadth: number; // 0..1 share of members agreeing with the ETF direction
  memberCount: number;
  gss: number; // signed strength ±100
  conviction: number; // 0..100
  bias: Direction | null;
  tradeable: boolean;
  blockers: string[];
  stocks: RankedStock[];
}

export interface MmSectorDeskData {
  generatedEt: string;
  sessionNote: string;
  regime: Regime;
  groups: DeskGroup[];
}

const SESSION_NOTE =
  "The real board is 09:45–10:00 ET — the first 15 minutes set the day's rotation.";

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

/** ETF ticker → { chg%, rvol× } from the single sector-ETF export. */
async function fetchEtfAnchors(): Promise<Map<string, { chg: number; rvol: number }>> {
  const data = await fetchExportFromUrl(sectorEtfExportUrl(), "sector-desk/etfs");
  const rows = parseGroupIndicatorRows(data, null);
  const map = new Map<string, { chg: number; rvol: number }>();
  for (const r of rows) {
    map.set(r.ticker, { chg: r.day_chg, rvol: r.rel_volume ?? 1 });
  }
  return map;
}

async function computeGroup(
  def: SectorDef,
  anchor: { chg: number; rvol: number } | undefined,
): Promise<DeskGroup> {
  const data = await fetchExportFromUrl(sectorExportUrl(def.slug), `sector-desk/${def.slug}`);
  const members = parseGroupIndicatorRows(data, null);

  const etfMove = anchor?.chg ?? 0;
  const etfRvol = anchor?.rvol ?? 1;
  const dir: 1 | -1 = etfMove >= 0 ? 1 : -1;

  // Breadth = share of members whose day move agrees with the ETF direction.
  let agree = 0;
  let counted = 0;
  for (const m of members) {
    if (m.day_chg === 0) continue;
    counted += 1;
    if (Math.sign(m.day_chg) === dir) agree += 1;
  }
  const breadth = counted > 0 ? agree / counted : 0;

  const score = groupStrength({ chg: etfMove, etfRvol, breadth });

  const stocks = rankStocks(
    members.map((m) => ({
      ticker: m.ticker,
      chg: m.day_chg,
      relVol: m.rel_volume ?? 0,
      dollarVol: (m.volume ?? 0) * m.close,
    })),
    dir,
  );

  return {
    key: def.key,
    sector: def.label,
    etf: def.etf,
    etfMove,
    etfRvol,
    breadth,
    memberCount: members.length,
    gss: score.gss,
    conviction: score.conviction,
    bias: score.bias,
    tradeable: score.tradeable,
    blockers: score.blockers,
    stocks,
  };
}

export async function computeSectorDesk(): Promise<MmSectorDeskData> {
  const anchors = await fetchEtfAnchors();

  const groups: DeskGroup[] = [];
  for (const def of SECTORS) {
    await sleep(FINVIZ_DELAY_MS); // courtesy pacing between exports
    groups.push(await computeGroup(def, anchors.get(def.etf)));
  }

  // Strongest signed strength first for display; router uses its own sort.
  groups.sort((a, b) => b.gss - a.gss);

  const lites: RegimeGroupLite[] = groups.map((g) => ({
    sector: g.sector,
    chg: g.etfMove,
    tradeable: g.tradeable,
    bias: g.bias,
  }));

  return {
    generatedEt: etStamp(),
    sessionNote: SESSION_NOTE,
    regime: routeRegime(lites),
    groups,
  };
}

// Re-export tuning so the timer/warm path can log it if desired.
export { TUNING };
