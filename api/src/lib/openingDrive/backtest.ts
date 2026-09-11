/**
 * Opening Drive — historical backtest.
 *
 * Reconstructs each day's gapper universe from Polygon whole-market grouped
 * daily bars (Finviz's screener is live-only), then runs the tested gate +
 * trigger logic and measures what each triggered name did for the rest of the
 * session: entry, the day's high, max favorable excursion (how far up), max
 * adverse excursion (how far it broke down), and whether the breakout-candle
 * stop was taken out.
 *
 * Data is Polygon historical (consolidated, full volume) — not delay-affected,
 * and a truer picture than the live IEX feed. Catalyst / ATR / room filters are
 * relaxed here (pure price-structure backtest, spec §replay no_catalyst=allow):
 * "if we took every liquid gapper that closed a 2-min bar over its pre-market
 * high, how did it perform?"
 */

import type { Candle } from "../indicators.js";
import { fetchAggsRange } from "../polygon.js";
import { fetchGroupedDaily, type GroupedBar } from "../rotation.js";
import { loadConfig, type OpeningDriveConfig } from "./config.js";
import { atr14 } from "./levels.js";
import { priorCloseBoundary } from "./catalyst.js";
import type { NewsItem } from "../cve.js";
import { fetchTickerNews } from "../cveData.js";
import {
  type Bar,
  evaluateGate,
  evaluateTrigger,
  rollToBars,
  etMinutes,
} from "./trigger.js";

export interface BacktestTrigger {
  date: string;
  ticker: string;
  gapPct: number;
  entry: number;
  entryEt: string;
  stop: number;
  riskPct: number;
  pmHigh: number;
  dayHigh: number; // highest print AFTER entry (not the full-session high)
  mfePct: number; // max up from entry, to close
  maePct: number; // max down from entry ("breakdown"), to close
  stopped: boolean;
  stoppedEt: string | null;
  closePct: number; // close vs entry
  // did the runner reach a clean multiple of risk before any stop-out?
  rMultipleToHigh: number;
  // ── context: how big a move was this, and why did it run? ──
  atr: number; // 14-day ATR ($), as of the prior close (no look-ahead)
  atrPct: number; // ATR as % of entry — the stock's normal daily range
  minutesToHigh: number; // minutes from entry bar to the day's high
  runVsAtrPct: number; // run-up (entry→high) as % of one ATR; 100% = 1 full ATR
  // NEWS = fresh headline in the overnight window (prior close → 09:30);
  // CONTEXT = freshest relevant headline within ~3 days before the open (theme,
  //   not necessarily the trigger); GAP = no indexed headline (sympathy/momentum).
  catalystType: "NEWS" | "CONTEXT" | "GAP";
  catalystHeadline: string | null; // the reason it ran, verbatim
  catalystSource: string | null; // wire / publisher
  catalystEt: string | null; // when the headline hit (ET)
  // Post-entry 2-min bars through the 4:00 close — the price path an exit rule
  // gets to work with (t = ET minutes since midnight). Research field only.
  path: { t: number; o: number; h: number; l: number; c: number }[];
}

export interface BacktestDay {
  date: string;
  gappers: number;
  gated: number;
  triggered: number;
  triggers: BacktestTrigger[];
}

export interface BacktestSummary {
  days: number;
  totalGappers: number;
  totalGated: number;
  totalTriggered: number;
  avgMfePct: number;
  avgMaePct: number;
  medianMfePct: number;
  stoppedCount: number;
  winnersOver2R: number; // reached >= 2x risk up before stopping
  hitRateOver2Pct: number; // fraction whose MFE reached >= +2%
}

export interface BacktestResult {
  from: string;
  to: string;
  summary: BacktestSummary;
  perDay: BacktestDay[];
}

const RTH_OPEN = 570; // 9:30
const RTH_CLOSE = 960; // 16:00
const PM_START = 240; // 04:00

function toBars(cs: Candle[]): Bar[] {
  return cs.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: c.timestamp }));
}

function etClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
}

async function groupedMap(date: string): Promise<Map<string, GroupedBar> | null> {
  const g = await fetchGroupedDaily(date);
  if (g.kind !== "ok") return null;
  const m = new Map<string, GroupedBar>();
  for (const b of g.bars) if (/^[A-Z]{1,5}$/.test(b.T)) m.set(b.T, b);
  return m;
}

/** Nearest trading day strictly before `date` (walks back over weekends/holidays). */
async function priorTradingDay(date: string): Promise<{ date: string; map: Map<string, GroupedBar> } | null> {
  const d = new Date(`${date}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const ds = d.toISOString().slice(0, 10);
    const m = await groupedMap(ds);
    if (m) return { date: ds, map: m };
  }
  return null;
}

/** Discover the day's gapper universe: gap%, price and $-volume floors. */
function discoverGappers(
  today: Map<string, GroupedBar>,
  prior: Map<string, GroupedBar>,
  cfg: OpeningDriveConfig,
): { ticker: string; gapPct: number; priorClose: number; ydayHigh: number }[] {
  const out: { ticker: string; gapPct: number; priorClose: number; ydayHigh: number }[] = [];
  for (const [ticker, td] of today) {
    const pd = prior.get(ticker);
    if (!pd || pd.c <= 0) continue;
    const gapPct = ((td.o - pd.c) / pd.c) * 100;
    const dollarVol = td.o * td.v;
    if (
      gapPct >= cfg.minGapPct &&
      td.o >= cfg.minPrice &&
      dollarVol >= cfg.minAvgDollarVol
    ) {
      out.push({ ticker, gapPct, priorClose: pd.c, ydayHigh: pd.h });
    }
  }
  // Strongest gaps first; cap the per-day set the way the live strategy does.
  return out.sort((a, b) => b.gapPct - a.gapPct).slice(0, 25);
}

/** ET 09:30 of a YYYY-MM-DD session as a Date (July/Aug → EDT, UTC-4). */
function sessionOpenEt(date: string): Date {
  return new Date(`${date}T09:30:00-04:00`);
}

/** Calendar day before `date` (YYYY-MM-DD) — the ATR window's inclusive end,
 *  so the backtest day's own range never leaks into its ATR (no look-ahead). */
function calendarDayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 14-day ATR ($) as of the prior close, from daily bars ending the day before. */
async function atrAsOf(ticker: string, date: string): Promise<number> {
  const from = new Date(`${date}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 45);
  const daily = await fetchAggsRange(ticker, 1, "day", from.toISOString().slice(0, 10), calendarDayBefore(date));
  return daily.length >= 2 ? atr14(daily) : 0;
}

/**
 * Why did it run? Polygon headlines, tiered by recency — never past 09:30, so no
 * look-ahead. NEWS = a fresh overnight headline (prior close → 09:30); CONTEXT =
 * the freshest headline in the ~3 days before the open (a live theme, but not
 * necessarily the trigger); GAP = nothing indexed (sympathy / momentum).
 */
async function catalystForDate(
  ticker: string,
  date: string,
): Promise<{ type: "NEWS" | "CONTEXT" | "GAP"; headline: string | null; source: string | null; et: string | null }> {
  const open = sessionOpenEt(date).getTime();
  const overnight = priorCloseBoundary(sessionOpenEt(date)); // prior 16:00 ET
  const recent = open - 3 * 24 * 3_600_000; // ~3 days back
  let news: NewsItem[] = [];
  try {
    news = await fetchTickerNews(ticker, 40);
  } catch {
    news = [];
  }
  const before = news
    .filter((n) => n.publishedUtc && new Date(n.publishedUtc).getTime() <= open)
    .sort((a, b) => new Date(b.publishedUtc).getTime() - new Date(a.publishedUtc).getTime());
  const top = before[0];
  if (!top) return { type: "GAP", headline: null, source: null, et: null };
  const t = new Date(top.publishedUtc).getTime();
  const info = { headline: top.title || null, source: top.publisher ?? null, et: etClock(t) };
  if (t > overnight) return { type: "NEWS", ...info };
  if (t > recent) return { type: "CONTEXT", ...info };
  return { type: "GAP", headline: null, source: null, et: null };
}

function premarketHigh(oneMin: Bar[]): number {
  let hi = 0;
  for (const b of oneMin) {
    const m = etMinutes(b.timestamp);
    if (m >= PM_START && m < RTH_OPEN) hi = Math.max(hi, b.high);
  }
  return hi;
}

async function backtestTicker(
  g: { ticker: string; gapPct: number; priorClose: number; ydayHigh: number },
  date: string,
  cfg: OpeningDriveConfig,
): Promise<{ gated: boolean; trigger: BacktestTrigger | null }> {
  const oneMin = toBars(await fetchAggsRange(g.ticker, 1, "minute", date, date));
  if (!oneMin.length) return { gated: false, trigger: null };

  const pmHigh = premarketHigh(oneMin);
  const rth = rollToBars(oneMin, cfg.barMinutes).filter((b) => {
    const m = etMinutes(b.timestamp);
    return m >= RTH_OPEN && m < RTH_CLOSE;
  });
  if (!rth.length || pmHigh <= 0) return { gated: false, trigger: null };

  const gate = evaluateGate(rth[0].open, g.ydayHigh, g.priorClose, cfg.gateMode);
  if (!gate.pass) return { gated: false, trigger: null };

  // Trigger scan in the 9:30–10:15 window; RVOL relaxed (structure backtest).
  const [sH, sM] = cfg.engineStopEt.split(":").map(Number);
  const stopMins = sH * 60 + sM;
  let trigBar: Bar | null = null;
  for (const bar of rth) {
    const m = etMinutes(bar.timestamp);
    if (m > stopMins) break;
    const chk = evaluateTrigger(bar, pmHigh, cfg.minRvol, cfg); // rvol satisfied
    if (chk.fired) { trigBar = bar; break; }
  }
  if (!trigBar) return { gated: true, trigger: null };

  // Outcome: everything after the trigger bar, through the RTH close.
  const entry = trigBar.close;
  const stop = trigBar.low;
  const risk = entry - stop;
  const after = rth.filter((b) => b.timestamp > trigBar!.timestamp);
  // Everything is measured strictly AFTER the breakout bar: we enter on its
  // close, so a high printed earlier in the session (e.g. an opening wick that
  // poked above the PMH but didn't close through it) is not capturable and must
  // not count. A name whose session high predates entry and then falls into the
  // stop is a losing trade, not a runner.
  let maxHigh = entry, minLow = entry, stoppedEt: string | null = null;
  let postHigh = after.length ? -Infinity : entry; // highest print after entry
  let highTs = trigBar.timestamp; // when that post-entry high occurred
  for (const b of after) {
    if (b.high > postHigh) { postHigh = b.high; highTs = b.timestamp; }
    if (b.high > maxHigh) maxHigh = b.high;
    minLow = Math.min(minLow, b.low);
    if (stoppedEt === null && b.low < stop) stoppedEt = etClock(b.timestamp);
  }
  const dayHigh = after.length ? postHigh : entry; // high reached AFTER entry
  const close = after.length ? after[after.length - 1].close : entry;
  const mfePct = ((maxHigh - entry) / entry) * 100;
  const maePct = ((minLow - entry) / entry) * 100;

  // Context — only computed for the names that actually triggered.
  const [atr, catalyst] = await Promise.all([atrAsOf(g.ticker, date), catalystForDate(g.ticker, date)]);
  const minutesToHigh = Math.round((highTs - trigBar.timestamp) / 60000);
  const runVsAtrPct = atr > 0 ? ((maxHigh - entry) / atr) * 100 : 0;
  const path = after.map((b) => ({ t: etMinutes(b.timestamp), o: b.open, h: b.high, l: b.low, c: b.close }));

  return {
    gated: true,
    trigger: {
      date,
      ticker: g.ticker,
      gapPct: g.gapPct,
      entry,
      entryEt: etClock(trigBar.timestamp),
      stop,
      riskPct: (risk / entry) * 100,
      pmHigh,
      dayHigh,
      mfePct,
      maePct,
      stopped: stoppedEt !== null,
      stoppedEt,
      closePct: ((close - entry) / entry) * 100,
      rMultipleToHigh: risk > 0 ? (maxHigh - entry) / risk : 0,
      atr,
      atrPct: entry > 0 ? (atr / entry) * 100 : 0,
      minutesToHigh,
      runVsAtrPct,
      catalystType: catalyst.type,
      catalystHeadline: catalyst.headline,
      catalystSource: catalyst.source,
      catalystEt: catalyst.et,
      path,
    },
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

export async function runBacktest(dates: string[], cfg: OpeningDriveConfig = loadConfig()): Promise<BacktestResult> {
  const perDay: BacktestDay[] = [];

  for (const date of dates) {
    const today = await groupedMap(date);
    if (!today) { perDay.push({ date, gappers: 0, gated: 0, triggered: 0, triggers: [] }); continue; }
    const prior = await priorTradingDay(date);
    if (!prior) { perDay.push({ date, gappers: 0, gated: 0, triggered: 0, triggers: [] }); continue; }

    const gappers = discoverGappers(today, prior.map, cfg);
    const results = await mapLimit(gappers, 6, (g) => backtestTicker(g, date, cfg));

    const triggers: BacktestTrigger[] = [];
    let gated = 0;
    for (const r of results) {
      if (r.gated) gated++;
      if (r.trigger) triggers.push(r.trigger);
    }
    triggers.sort((a, b) => b.mfePct - a.mfePct);
    perDay.push({ date, gappers: gappers.length, gated, triggered: triggers.length, triggers });
  }

  const allTrig = perDay.flatMap((d) => d.triggers);
  const mfes = allTrig.map((t) => t.mfePct).sort((a, b) => a - b);
  const median = mfes.length ? mfes[Math.floor(mfes.length / 2)] : 0;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const summary: BacktestSummary = {
    days: dates.length,
    totalGappers: perDay.reduce((s, d) => s + d.gappers, 0),
    totalGated: perDay.reduce((s, d) => s + d.gated, 0),
    totalTriggered: allTrig.length,
    avgMfePct: avg(allTrig.map((t) => t.mfePct)),
    avgMaePct: avg(allTrig.map((t) => t.maePct)),
    medianMfePct: median,
    stoppedCount: allTrig.filter((t) => t.stopped).length,
    winnersOver2R: allTrig.filter((t) => t.rMultipleToHigh >= 2).length,
    hitRateOver2Pct: allTrig.length ? allTrig.filter((t) => t.mfePct >= 2).length / allTrig.length : 0,
  };

  return { from: dates[0], to: dates[dates.length - 1], summary, perDay };
}
