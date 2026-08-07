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

import { fetchExportFromUrl, parseGroupIndicatorRows, FINVIZ_DELAY_MS, type IndicatorRow } from "./finviz.js";
import { SECTORS, sectorExportUrl, sectorEtfExportUrl, type SectorDef } from "./deskSources.js";
import { getMaLevels, getEmaLevels, currentEma, distPct } from "./maEnrich.js";
import { ALL_TICKERS as ROTATION_TICKERS } from "../rotationUniverse.js";
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

/** A ranked stock plus its price context: change-from-open and % distance from
 * each moving average (positive = price above the MA). MA fields are null when
 * the source lacked enough history. */
export interface DeskStock extends RankedStock {
  close: number;
  changeFromOpen: number | null;
  distSma50: number | null;
  distSma200: number | null;
  distEma10: number | null;
  distEma20: number | null;
  dist5day: number | null; // 65-bar 30-min SMA (the "5-day" line)
}

export interface DeskGroup {
  key: string;
  sector: string; // display label
  etf: string;
  etfMove: number; // ETF full-day change % (reference)
  etfFromOpen: number; // ETF change-from-open % — the signal that drives the desk
  etfRvol: number; // ETF relative volume × (reference only — no longer gates)
  volParticipation: number; // 0..1 share of members trading ≥ their avg volume (gates)
  breadth: number; // 0..1 share of members agreeing with the ETF direction
  memberCount: number;
  gss: number; // signed strength ±100
  conviction: number; // 0..100
  bias: Direction | null;
  tradeable: boolean;
  blockers: string[];
  stocks: DeskStock[];
}

/**
 * Per-stock price context for the Rotation tab, keyed by ticker.
 *
 * A by-product of this warm, not a second data pull: the sector exports below
 * already return EVERY liquid member with all of these fields, and `rankStocks`
 * throws all but the top 12 away. Rotation wants the same columns across its
 * whole universe, so we keep the discarded rows instead of re-fetching them.
 *
 * No `dist5day` — that line needs Alpaca 30-min bars, which don't scale to this
 * many tickets inside a function timeout (see `getEmaLevels`).
 */
export interface RotationStockRow {
  close: number;
  chg: number; // full-day change %
  changeFromOpen: number | null;
  relVol: number | null;
  dollarVol: number;
  distSma50: number | null;
  distSma200: number | null;
  distEma10: number | null;
  distEma20: number | null;
}

export type RotationEnrichMap = Record<string, RotationStockRow>;

export interface MmSectorDeskData {
  generatedEt: string;
  sessionNote: string;
  regime: Regime;
  groups: DeskGroup[];
  /**
   * Split out of the stored `sector-desk` payload by mm-timer and written to its
   * own `rotation-stocks` panel — the Desk tab shouldn't download ~800 rows it
   * never renders.
   */
  rotationEnrich?: RotationEnrichMap;
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

interface Anchor { chg: number; fromOpen: number; rvol: number }

/** ETF ticker → { day chg%, change-from-open%, rvol× } from the sector-ETF export. */
async function fetchEtfAnchors(): Promise<Map<string, Anchor>> {
  const data = await fetchExportFromUrl(sectorEtfExportUrl(), "sector-desk/etfs");
  const rows = parseGroupIndicatorRows(data, null);
  const map = new Map<string, Anchor>();
  for (const r of rows) {
    map.set(r.ticker, { chg: r.day_chg, fromOpen: r.open_chg, rvol: r.rel_volume ?? 1 });
  }
  return map;
}

async function computeGroup(
  def: SectorDef,
  anchor: Anchor | undefined,
): Promise<{ group: DeskGroup; members: IndicatorRow[] }> {
  const data = await fetchExportFromUrl(sectorExportUrl(def.slug), `sector-desk/${def.slug}`);
  const members = parseGroupIndicatorRows(data, null);

  const etfMove = anchor?.chg ?? 0; // full-day change (reference)
  const etfFromOpen = anchor?.fromOpen ?? 0; // change-from-open — the day-trade signal that drives the desk
  const etfRvol = anchor?.rvol ?? 1;
  const dir: 1 | -1 = etfFromOpen >= 0 ? 1 : -1;

  // Breadth = share of members whose CHANGE-FROM-OPEN agrees with the ETF's.
  let agree = 0;
  let counted = 0;
  for (const m of members) {
    if (m.open_chg === 0) continue;
    counted += 1;
    if (Math.sign(m.open_chg) === dir) agree += 1;
  }
  const breadth = counted > 0 ? agree / counted : 0;

  // Volume participation = share of members trading at/above their own average
  // volume (rel-vol ≥ floor). This is the real "is the sector active" signal —
  // the ETF's own volume misfires when the wrapper is quiet but names run hot.
  let participating = 0;
  let volCounted = 0;
  for (const m of members) {
    if (m.rel_volume === null || m.rel_volume === undefined) continue;
    volCounted += 1;
    if (m.rel_volume >= TUNING.volParticipationFloor) participating += 1;
  }
  const volParticipation = volCounted > 0 ? participating / volCounted : 0;

  const score = groupStrength({ chg: etfFromOpen, volPart: volParticipation, breadth });

  const ranked = rankStocks(
    members.map((m) => ({
      ticker: m.ticker,
      chg: m.day_chg, // display only
      moveForRank: m.open_chg, // rank/align on change-from-open
      relVol: m.rel_volume ?? 0,
      dollarVol: (m.volume ?? 0) * m.close,
    })),
    dir,
  );

  // Attach FinViz-derived price context (change-from-open + SMA50/200 distance)
  // from each ranked name's member row. EMA10/20 + 5-day are filled later in one
  // batched pass so the whole desk makes a single Polygon/Alpaca round-trip.
  const byTicker = new Map<string, IndicatorRow>(members.map((m) => [m.ticker, m]));
  const stocks: DeskStock[] = ranked.map((r) => {
    const m = byTicker.get(r.ticker);
    const close = m?.close ?? 0;
    return {
      ...r,
      close,
      changeFromOpen: m?.open_chg ?? null,
      distSma50: m ? distPct(close, m.sma50) : null,
      distSma200: m ? distPct(close, m.sma200) : null,
      distEma10: null,
      distEma20: null,
      dist5day: null,
    };
  });

  return {
    group: {
      key: def.key,
      sector: def.label,
      etf: def.etf,
      etfMove,
      etfFromOpen,
      etfRvol,
      volParticipation,
      breadth,
      memberCount: members.length,
      gss: score.gss,
      conviction: score.conviction,
      bias: score.bias,
      tradeable: score.tradeable,
      blockers: score.blockers,
      stocks,
    },
    members,
  };
}

/**
 * Build the Rotation per-stock enrichment from the sector-export members.
 *
 * Restricted to the Rotation universe: the sector exports return every liquid US
 * stock (thousands), and Rotation only ever renders its own ~880 classified
 * names. Anything Rotation shows that isn't here — a name below FinViz's 1M
 * avg-volume floor, say — simply renders "–" for these columns.
 */
async function buildRotationEnrich(members: IndicatorRow[]): Promise<RotationEnrichMap> {
  const wanted = new Set(ROTATION_TICKERS);
  const rows = members.filter((m) => wanted.has(m.ticker));

  const ema = await getEmaLevels(rows.map((m) => m.ticker));

  const out: RotationEnrichMap = {};
  for (const m of rows) {
    const close = m.close ?? 0;
    const lv = ema.get(m.ticker);
    out[m.ticker] = {
      close,
      chg: m.day_chg,
      changeFromOpen: Number.isFinite(m.open_chg) ? m.open_chg : null,
      relVol: m.rel_volume,
      dollarVol: (m.volume ?? 0) * close,
      distSma50: distPct(close, m.sma50),
      distSma200: distPct(close, m.sma200),
      distEma10: distPct(close, currentEma(lv?.emaPrev10 ?? null, close, 10)),
      distEma20: distPct(close, currentEma(lv?.emaPrev20 ?? null, close, 20)),
    };
  }
  return out;
}

export async function computeSectorDesk(): Promise<MmSectorDeskData> {
  const anchors = await fetchEtfAnchors();

  const groups: DeskGroup[] = [];
  const allMembers: IndicatorRow[] = [];
  for (const def of SECTORS) {
    await sleep(FINVIZ_DELAY_MS); // courtesy pacing between exports
    const { group, members } = await computeGroup(def, anchors.get(def.etf));
    groups.push(group);
    allMembers.push(...members);
  }

  // One batched MA round-trip for every displayed name across all groups:
  // EMA10/20 (Polygon daily, folded with the live price) + the 5-day 65-bar
  // 30-min SMA (Alpaca IEX). Distances use FinViz's real-time close.
  const allTickers = groups.flatMap((g) => g.stocks.map((s) => s.ticker));
  const ma = await getMaLevels(allTickers);
  for (const g of groups) {
    for (const s of g.stocks) {
      const lv = ma.get(s.ticker);
      if (!lv) continue;
      s.distEma10 = distPct(s.close, currentEma(lv.emaPrev10, s.close, 10));
      s.distEma20 = distPct(s.close, currentEma(lv.emaPrev20, s.close, 20));
      s.dist5day = distPct(s.close, lv.fiveDay);
    }
  }

  // Rotation enrichment — the members the desk's top-12 cut discarded, narrowed
  // to the Rotation universe so the panel stays ~800 rows instead of every
  // liquid US stock. EMA-only (no Alpaca) so this scales; see getEmaLevels.
  const rotationEnrich = await buildRotationEnrich(allMembers);

  // Strongest signed strength first for display; router uses its own sort.
  groups.sort((a, b) => b.gss - a.gss);

  const lites: RegimeGroupLite[] = groups.map((g) => ({
    sector: g.sector,
    chg: g.etfFromOpen, // regime dispersion/direction on change-from-open
    tradeable: g.tradeable,
    bias: g.bias,
  }));

  return {
    rotationEnrich,
    generatedEt: etStamp(),
    sessionNote: SESSION_NOTE,
    regime: routeRegime(lites),
    groups,
  };
}

// Re-export tuning so the timer/warm path can log it if desired.
export { TUNING };
