/**
 * AVWAP-from-Earnings + 21/50 EMA snapshot, and the line-cross alerts.
 *
 * The MASTER TradingView watchlist (~193 symbols) is swept on DESKTOP2 by
 * tools/tv-avwap/publish_avwap.mjs against the 39-minute chart. Per symbol it
 * reports the distance from three levels, in percent:
 *
 *     pct = (close - level) / level * 100      (positive = above the level)
 *
 *   avwap  "VWAP Auto Anchored", Anchor Period = Earnings — chart truth, the
 *          same indicator the operator looks at. The cloud never re-derives it:
 *          the anchor is TradingView's own earnings-date series.
 *   ema21  21-period EMA of 39m closes, computed by the publisher from the bar
 *   sma50  50-period SMA of 39m closes    -- these mirror what the operator
 *          actually draws on the chart: a 21 EMA and a 50 SMA, not two EMAs.
 *
 * ── Alert rule (operator, 2026-08-17, second revision) ────────────────────
 *
 *   CROSS_UP    the candle CLOSES at or above the level, previous candle below
 *   CROSS_DOWN  the candle CLOSES at or below the level, previous candle above
 *
 * Symmetric, and identical on all four levels. No level has extra behaviour and
 * no other event type alerts — "all alerts crossing up or down only".
 *
 * History, because this moved twice in one day and the reasoning matters:
 * 2026-08-15 shipped CROSS_UP on every level plus TOUCH_DOWN on the AVWAP alone
 * ("extended above, comes back and touches"). That was removed in the morning —
 * it was not a clean cross, it was asymmetric, and it applied to one level out
 * of four. What replaced it is the symmetric cross, which is what was wanted all
 * along. So a down alert is BACK, but it is a different rule: a real close
 * through the level, on every level, not an AVWAP mean-reversion touch.
 *
 * Crucially the publisher decides "previous candle" from two adjacent BARS on
 * the chart, not from two successive publishes, and scores the last genuinely
 * CLOSED bar rather than the forming one. So these numbers already mean what
 * the rule says, whatever the publish cadence is, and a bar that pokes above a
 * level mid-formation and settles back under it never alerts.
 *
 * Two guards stop a symbol sitting on a level from spamming:
 *   - deadband: the previous candle must have been at least AVWAP_CROSS_MIN_PCT
 *     away from the level (default 0.25%)
 *   - dedup keyed on the BAR, not the day: one alert per
 *     ticker+level+direction+bar. A symbol may legitimately cross up, fall back
 *     and cross again later — that is two different bars and two alerts — while
 *     the same bar re-swept every 5 minutes only ever alerts once. Table-backed,
 *     not in-process: this endpoint routinely hits a cold worker, where an
 *     in-memory cache is empty and would re-alert everything it had already sent.
 */

import { upsert, getOne, listByPartition, remove, TABLES } from "./tables.js";
import { notifyBoth } from "./notifyBoth.js";

export const CURRENT_PK = "current";
export const META_RK = "__meta__";

const DEFAULT_CROSS_MIN_PCT = 0.25;
const DEFAULT_STALE_MIN = 15;

/**
 * Deadband for calling a level's own slope UP or DOWN.
 *
 * A 5-day average is heavily smoothed, so its slope is small in absolute terms
 * and hovers around zero on a rangebound name. Without a deadband a flat line
 * would report UP and DOWN on alternating bars purely on rounding, and the
 * "above and rising" count - the whole point of the metric - would flicker.
 *
 * 0.10% over the publisher's slope window is a deliberately low bar: the raw
 * slope ships alongside the label so the real distribution is visible on the
 * tab, and this can be retuned from the observed spread rather than guessed at
 * twice.
 */
const DEFAULT_SLOPE_MIN_PCT = 0.10;

export type SlopeDirection = "UP" | "DOWN" | "FLAT";

function slopeMinPct(): number {
  const n = Number(process.env.AVWAP_SLOPE_MIN_PCT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLOPE_MIN_PCT;
}

/**
 * Which way the LEVEL is pointing - a different question from where price sits
 * relative to it, and the one that decides whether a 5-day SMA is worth
 * trading against or is just a falling line price happens to be crossing.
 *
 * Pure and exported so `api/tools/avwap-rules-test.mjs` can pin it the same way
 * it pins classifyCross().
 */
export function classifySlope(
  slope: number | null | undefined,
  minPct: number = slopeMinPct(),
): SlopeDirection | "" {
  if (slope === null || slope === undefined || !Number.isFinite(slope)) return "";
  if (slope >= minPct) return "UP";
  if (slope <= -minPct) return "DOWN";
  return "FLAT";
}

export const LEVELS = ["avwap", "sma50", "ema21d", "sma50d"] as const;
export type Level = (typeof LEVELS)[number];
export type CrossDirection = "CROSS_UP" | "CROSS_DOWN";

export const LEVEL_LABEL: Record<Level, string> = {
  avwap: "AVWAP(Earnings)",
  // Spelled out in days: "5D SMA" and "50 SMA D" read almost identically in an
  // alert on a phone, and they are ~7.6 apart on MXL. Worth the extra chars.
  sma50: "5-Day SMA (50x39m)",
  ema21d: "21-Day EMA",
  sma50d: "50-Day SMA",
};

/**
 * One published row. Per level L the publisher sends four numbers:
 *   L            the plotted level value on the live bar
 *   pct_L        distance of the LIVE close from it   (display)
 *   c_pct_L      distance of the last CLOSED candle   (alerting)
 *   p_pct_L      distance of the candle before that   (alerting)
 */
export interface AvwapInputRow {
  ticker?: string;
  close?: number;
  last_bar_closed?: boolean;
  closed_time?: number;
  prev_time?: number;
  closed_close?: number;
  prev_close?: number;
  [key: string]: unknown;
}

export interface CrossEvent {
  ticker: string;
  level: Level;
  direction: CrossDirection;
  prevPct: number;
  pct: number;
  close: number;
  levelValue: number;
  barTime: number;
}

export interface AvwapRow {
  ticker: string;
  /** Exchange-qualified symbol for chart deep-links, e.g. "NASDAQ:MXL". */
  sym: string;
  close: number;
  /** Plotted level value, per level key. */
  levels: Record<string, number | null>;
  /** Distance of the live close from each level, in percent. */
  pct: Record<string, number | null>;
  /**
   * Direction of each LEVEL itself over the publisher's slope window, in
   * percent. Positive = the line is rising. Null when the symbol is too young
   * to have that much history behind the level.
   */
  slope: Record<string, number | null>;
  /** UP / DOWN / FLAT per level, `slope` put through the deadband. */
  slopeDir: Record<string, SlopeDirection | "">;
  /** Every level cleared on that bar: "sma50,ema21d:CROSS_UP". */
  lastCross: string;
  lastCrossAt: string;
}

export interface AvwapSnapshot {
  rows: AvwapRow[];
  barUtc: string;
  publishedAt: string;
  receivedAt: string;
  host: string;
  ageMin: number;
  stale: boolean;
  failed: string[];
  /**
   * Today's crossings per level and direction, as TICKER lists so the tab can
   * both count them and filter to them.
   *
   * Read from the history partition, NOT from each row's `lastCross`. A name
   * that reclaimed its AVWAP at 07:12 and lost it again at 11:03 did two things
   * today; `lastCross` only remembers the second. Counting off `lastCross` would
   * quietly under-report exactly the choppy names worth looking at.
   */
  todayCross: Record<string, { up: string[]; down: string[] }>;
  /**
   * The ET date `todayCross` actually describes. Not always "today": the matrix
   * holds the last session's crossings through the overnight and premarket, and
   * falls further back across weekends and holidays. The tab labels off this
   * instead of hardcoding the word "today".
   */
  crossDay: string;
  /** True when `crossDay` is the session currently in progress. */
  crossDayIsCurrent: boolean;
  /** Bars the publisher measured `slope` over, so the tab can label the column. */
  slopeBars: number;
}

/** Historical rows say TOUCH_DOWN; it means the same side as CROSS_DOWN. */
const isDown = (dir: string) => dir === "CROSS_DOWN" || dir === "TOUCH_DOWN";

function crossMinPct(): number {
  const n = Number(process.env.AVWAP_CROSS_MIN_PCT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CROSS_MIN_PCT;
}

function staleMin(): number {
  const n = Number(process.env.AVWAP_STALE_MIN);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MIN;
}

/** RTH = 9:30–16:00 ET weekdays. Staleness only means something while open. */
export function isRthNow(now = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/**
 * The whole alert rule, in one pure function. Exercised by
 * `api/tools/avwap-rules-test.mjs` — run it before changing this.
 *
 * `prevPct` is the PREVIOUS closed candle's distance from the level and `pct`
 * the latest closed candle's. Positive = above the level.
 *
 * The deadband applies to the PREVIOUS candle only: a candle that closed within
 * minPct of the level was sitting ON it, not on one side of it, so the next
 * candle closing through is not a crossing. It is deliberately NOT applied to
 * `pct` — clearing the level at all is the signal; how far past it is not.
 *
 * Perfectly symmetric. If you are changing one branch here, change both, and
 * check `avwap-rules-test.mjs` still mirrors them.
 */
export function classifyCross(
  prevPct: number | null | undefined,
  pct: number | null | undefined,
  minPct: number = crossMinPct(),
): CrossDirection | "" {
  if (prevPct === null || prevPct === undefined || !Number.isFinite(prevPct)) return "";
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "";
  if (Math.abs(prevPct) < minPct) return "";
  if (prevPct < 0 && pct >= 0) return "CROSS_UP";
  if (prevPct > 0 && pct <= 0) return "CROSS_DOWN";
  return "";
}

/**
 * A sweep must look healthy before we let it delete anything.
 *
 * Pruning is the only operation here that removes data, and it runs unattended
 * every 39 minutes. A publisher that half-fails — TradingView mid-restart, the
 * watchlist briefly empty, a chart that stops resolving symbols — would
 * otherwise be read as "the operator deleted 150 names" and empty the tab.
 * Below either threshold we keep the stale rows, which is the recoverable
 * failure; the next healthy sweep prunes them.
 */
export const PRUNE_MIN_SWEPT = 50;
export const PRUNE_MAX_FAILED_FRAC = 0.25;

/**
 * Encode what a symbol did on one bar into the `lastCross` field.
 *
 * Now that both directions fire, a single bar can send a name UP through one
 * level and DOWN through another — reclaiming the AVWAP while losing the 50-day
 * is an ordinary Tuesday. So the direction rides per level rather than once for
 * the whole value:
 *
 *     "avwap:CROSS_UP,sma50d:CROSS_DOWN"
 *
 * `decodeLastCross` also reads the two older shapes still sitting in the table,
 * so nothing has to be migrated:
 *
 *     "sma50:CROSS_UP"            single level, every build
 *     "avwap,sma50d:CROSS_UP"     multi-level, shipped earlier today
 *     "avwap:TOUCH_DOWN"          the retired AVWAP touch rule
 */
export function encodeLastCross(pairs: { level: Level; dir: CrossDirection }[]): string {
  return pairs.map((p) => `${p.level}:${p.dir}`).join(",");
}

export function decodeLastCross(value: string): { level: string; dir: string }[] {
  if (!value) return [];
  const out: { level: string; dir: string }[] = [];
  const pending: string[] = [];
  for (const token of value.split(",")) {
    const [level, dir] = token.split(":");
    if (!level) continue;
    if (!dir) { pending.push(level); continue; }   // legacy bare level
    // A bare level inherits the next direction it finds — that is exactly what
    // "avwap,sma50d:CROSS_UP" meant when one direction covered the whole value.
    for (const p of pending.splice(0)) out.push({ level: p, dir });
    out.push({ level, dir });
  }
  // Trailing bare levels with no direction anywhere: unusable, drop them.
  return out;
}

/** Bare, upper-case ticker from either "AAOI" or "NASDAQ:AAOI". */
function bareTicker(s: string): string {
  return String(s).split(":").pop()!.trim().toUpperCase();
}

/**
 * Which `current` rows no longer belong, given what the sweep reported.
 *
 * The roster is `swept ∪ failed`, NOT `swept` alone. A symbol the publisher
 * could not read this cycle is still in MASTER — pruning on `swept` would drop
 * it and let the next sweep put it back, so a thin name would flicker on and
 * off the tab instead of just holding its last values.
 *
 * Pure so `api/tools/avwap-rules-test.mjs` can cover it: nothing that deletes
 * rows unattended should be reachable only through a live publish.
 */
export function planPrune(
  currentTickers: string[],
  swept: string[],
  failed: string[],
): { prune: string[]; heldBack: string } {
  if (swept.length < PRUNE_MIN_SWEPT) {
    return { prune: [], heldBack: `only ${swept.length} symbols swept` };
  }
  const roster = new Set([...swept, ...failed].map(bareTicker));
  const failedFrac = roster.size ? failed.length / roster.size : 1;
  if (failedFrac > PRUNE_MAX_FAILED_FRAC) {
    return { prune: [], heldBack: `${failed.length}/${roster.size} symbols failed to read` };
  }
  return {
    prune: currentTickers.filter((t) => t !== META_RK && !roster.has(bareTicker(t))),
    heldBack: "",
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function etDayStr(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * The ET date of the SESSION the crossing matrix belongs to, rolling at
 * 09:30 ET (06:30 PT) rather than at midnight.
 *
 * Writes key on `etDayStr()` and always land during RTH, so the two agree while
 * the market is open. They diverge exactly where it matters: between 00:00 ET
 * and 09:30 ET, `etDayStr()` has already rolled to a partition nothing has
 * written to yet, so the matrix read zero for every level from 21:00 PT until
 * the first genuine crossing of the next session (~07:49 PT — the 06:31 and
 * 07:10 sweeps score the PREVIOUS session's last bar, which dedup suppresses).
 *
 * That blanked the whole overnight and premarket, which is when you actually
 * want to review what crossed. Rolling at the open keeps the last session's
 * crossings on screen right up until the new feed starts producing its own.
 */
export function sessionDayStr(now = new Date()): string {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 9 * 60 + 30) return etDayStr(now);
  const prev = new Date(now.getTime() - 24 * 3600 * 1000);
  return etDayStr(prev);
}

/** `d` shifted back `n` calendar days, as an ET date string. */
function etDayMinus(d: string, n: number): string {
  const t = Date.parse(`${d}T12:00:00Z`);
  return etDayStr(new Date(t - n * 24 * 3600 * 1000));
}

/**
 * How far back to look for the most recent session that actually recorded
 * crossings. Weekends and holidays leave empty partitions behind, so without a
 * walk-back the matrix would blank every Saturday morning and stay blank all
 * weekend. Four days clears a Fri→Mon gap plus a holiday on either end.
 *
 * The walk-back is why `crossDay` ships in the payload: on a genuinely quiet
 * session it will surface the PREVIOUS day's crossings, and the tab has to be
 * able to say so rather than passing them off as today's.
 */
const CROSS_LOOKBACK_DAYS = 4;

/** ET calendar date of a BAR, from its epoch seconds. */
function barDayStr(barTime: number): string {
  return new Date(barTime * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export interface RecordResult {
  stored: number;
  skipped: number;
  /** Tickers dropped from `current` because they left the MASTER watchlist. */
  pruned: string[];
  /** Non-empty when the prune was held back because the sweep looked degraded. */
  pruneHeldBack: string;
  crossings: CrossEvent[];
}

export async function recordSnapshot(
  rows: AvwapInputRow[],
  opts: { barUtc: string; publishedAt: string; host: string; failed: string[]; slopeBars?: number },
): Promise<RecordResult> {
  const nowIso = new Date().toISOString();
  const minPct = crossMinPct();

  let previous: Record<string, Record<string, unknown>> = {};
  try {
    const prevRows = await listByPartition<Record<string, unknown>>(
      TABLES.AVWAP_EARNINGS, CURRENT_PK);
    previous = Object.fromEntries(prevRows.map((r) => [String(r.rowKey), r]));
  } catch {
    previous = {};
  }

  const crossings: CrossEvent[] = [];
  let stored = 0;
  let skipped = 0;

  // Every ticker the publisher MENTIONED, not just the ones we stored. A MASTER
  // symbol whose levels were unreadable is still in MASTER, so it must count
  // toward the roster or the prune below would delete it for being thin.
  const sent: string[] = [];

  for (const raw of rows) {
    const ticker = String(raw.ticker ?? "").trim().toUpperCase();
    const close = num(raw.close);
    if (ticker) sent.push(ticker);
    if (!ticker || close === null) { skipped++; continue; }

    const barTime = num(raw.closed_time) ?? 0;
    const closedClose = num(raw.closed_close) ?? close;

    const entity: Record<string, unknown> = {
      ticker,
      // Fully-qualified TradingView symbol (NASDAQ:MXL). The portal deep-links
      // the operator's own 39m layout with it, so it must be exchange-qualified
      // - a bare ticker can resolve to a different listing.
      sym: String(raw.sym ?? "") || null,
      close,
      barUtc: opts.barUtc,
      publishedAt: opts.publishedAt || nowIso,
      receivedAt: nowIso,
      host: opts.host,
    };

    // A row must carry at least the AVWAP to be worth storing; individual MA
    // levels may legitimately be absent for a thin symbol.
    if (num(raw.avwap) === null) { skipped++; continue; }

    // EVERY level this symbol cleared on this bar, not just one. All crossings
    // in a sweep are scored against the same closed bar, so they belong to the
    // same event — a name reclaiming three levels at once is a different animal
    // from one clipping a single line, and the tab has to be able to say so.
    const crossedLevels: { level: Level; dir: CrossDirection }[] = [];

    for (const level of LEVELS) {
      const value = num(raw[level]);
      const livePct = num(raw[`pct_${level}`]);
      entity[level] = value;
      entity[`pct_${level}`] = livePct;

      // Slope of the level itself. Stored whether or not anything crossed: the
      // "above and rising" count is a live property of every row, not just of
      // the ones that crossed today.
      const slope = num(raw[`slope_${level}`]);
      entity[`slope_${level}`] = slope;

      const c = num(raw[`c_pct_${level}`]);
      const p = num(raw[`p_pct_${level}`]);
      const dir = classifyCross(p, c, minPct);
      if (!dir || barTime <= 0) continue;
      if (await alreadyAlerted(ticker, level, dir, barTime)) continue;

      crossings.push({
        ticker, level, direction: dir,
        prevPct: p as number, pct: c as number,
        close: closedClose, levelValue: value ?? 0, barTime,
      });
      crossedLevels.push({ level, dir });

      await upsert(
        TABLES.AVWAP_EARNINGS,
        etDayStr(),
        `${nowIso.slice(11, 19).replace(/:/g, "")}-${ticker}-${level}`,
        {
          ticker, level, direction: dir,
          prevPct: Number((p as number).toFixed(4)),
          pct: Number((c as number).toFixed(4)),
          close: closedClose, levelValue: value ?? 0,
          // The level's OWN direction at the moment it was crossed.
          //
          // This is the field that makes the trend metric answerable rather
          // than merely visible: a live "above and rising" count tells you what
          // is true now, but only a slope stamped onto the crossing itself lets
          // you go back and ask whether crossing up through a RISING 5-day SMA
          // actually behaved differently from crossing up through a falling
          // one. Written here because this is the only place that sees both the
          // crossing and the slope on the same closed bar.
          slope: slope,
          slopeDir: classifySlope(slope),
          barTime, barIso: new Date(barTime * 1000).toISOString(),
          firedAt: nowIso, host: opts.host,
        },
      );
    }

    if (crossedLevels.length) {
      entity.lastCross = encodeLastCross(crossedLevels);
      entity.lastCrossAt = nowIso;
    } else {
      const prevRow = previous[ticker];
      if (prevRow?.lastCross) entity.lastCross = prevRow.lastCross;
      if (prevRow?.lastCrossAt) entity.lastCrossAt = prevRow.lastCrossAt;
    }

    await upsert(TABLES.AVWAP_EARNINGS, CURRENT_PK, ticker, entity);
    stored++;
  }

  // The tab shows the MASTER watchlist, so `current` has to BE the watchlist.
  // upsert() alone only ever adds, so a symbol removed from MASTER kept its last
  // row forever and read as live data (KXIAY sat there for hours on 2026-08-17).
  const { prune, heldBack } = planPrune(Object.keys(previous), sent, opts.failed);
  for (const ticker of prune) {
    await remove(TABLES.AVWAP_EARNINGS, CURRENT_PK, ticker);
  }

  await upsert(TABLES.AVWAP_EARNINGS, CURRENT_PK, META_RK, {
    barUtc: opts.barUtc,
    publishedAt: opts.publishedAt || nowIso,
    receivedAt: nowIso,
    host: opts.host,
    count: stored,
    // Carried so the tab labels the slope column with the window actually used,
    // not one hardcoded in the frontend that silently goes stale the moment
    // TV_SLOPE_BARS is retuned on the publisher.
    slopeBars: Number(opts.slopeBars) > 0 ? Number(opts.slopeBars) : 0,
    // A dead feed must never look like a quiet market — carry the publisher's
    // own failure list through to the tab.
    failed: opts.failed.join(",").slice(0, 30000),
    failedCount: opts.failed.length,
    // Same reasoning for the prune: a silent delete and a silently skipped
    // delete look identical from the tab unless both are recorded.
    pruned: prune.join(",").slice(0, 30000),
    prunedCount: prune.length,
    pruneHeldBack: heldBack,
  });

  if (crossings.length) {
    await alertCrossings(crossings);
    for (const c of crossings) {
      await markAlerted(c.ticker, c.level, c.direction, c.barTime);
    }
  }

  return { stored, skipped, pruned: prune, pruneHeldBack: heldBack, crossings };
}

/**
 * Dedup key, derived ENTIRELY from the bar - never from "today".
 *
 * The partition used to be the current ET date while the row key carried the
 * bar time, so the same bar scored on a different calendar day landed in a
 * different partition and looked un-alerted.
 *
 * That is not hypothetical. At 06:31 PT the session's first 39m bar is still
 * forming, so the last CLOSED bar is the previous session's final bar - the one
 * already alerted on. Under the old key, Monday's first run would have re-fired
 * every crossing from Friday's close, as a burst at the open, on stale signals.
 *
 * Keying both halves off the bar makes dedup a property of the bar itself: the
 * same bar is suppressed no matter when or how often it is re-scored, while a
 * genuine later cross on a NEW bar still alerts.
 */
export function alertKey(ticker: string, level: Level, dir: string, barTime: number): [string, string] {
  return [`alert-${barDayStr(barTime)}`, `${ticker}-${level}-${dir}-${barTime}`];
}

async function alreadyAlerted(
  ticker: string, level: Level, dir: string, barTime: number,
): Promise<boolean> {
  const [pk, rk] = alertKey(ticker, level, dir, barTime);
  return (await getOne(TABLES.AVWAP_EARNINGS, pk, rk)) !== null;
}

async function markAlerted(
  ticker: string, level: Level, dir: string, barTime: number,
): Promise<void> {
  const [pk, rk] = alertKey(ticker, level, dir, barTime);
  await upsert(TABLES.AVWAP_EARNINGS, pk, rk, { at: new Date().toISOString() });
}

/**
 * One message per sweep — never one per ticker. That is what keeps both
 * directions on all four levels down to ~10 messages a day instead of ~190:
 * the event count grows, the message count does not.
 */
async function alertCrossings(events: CrossEvent[]): Promise<void> {
  const lines: string[] = [];
  for (const level of LEVELS) {
    const ups = events.filter((e) => e.level === level && e.direction === "CROSS_UP");
    if (ups.length) {
      lines.push(`▲ Closed above ${LEVEL_LABEL[level]}: ` +
        ups.map((e) => `${e.ticker} ${e.close}`).join(", "));
    }
  }
  for (const level of LEVELS) {
    const downs = events.filter((e) => e.level === level && e.direction === "CROSS_DOWN");
    if (downs.length) {
      lines.push(`▼ Closed below ${LEVEL_LABEL[level]}: ` +
        downs.map((e) => `${e.ticker} ${e.close}`).join(", "));
    }
  }
  const ups = events.filter((e) => e.direction === "CROSS_UP").length;
  try {
    await notifyBoth(
      `AVWAP/EMA cross — ${ups}▲ ${events.length - ups}▼`,
      lines.join("\n"),
      "avwap-earnings",
      { count: events.length },
    );
  } catch {
    // notifyBoth is already best-effort; a notification failure must never fail
    // the publish, or the publisher retries and re-sends the whole sweep.
  }
}

export async function getSnapshot(): Promise<AvwapSnapshot> {
  const out: AvwapSnapshot = {
    rows: [], barUtc: "", publishedAt: "", receivedAt: "",
    host: "", ageMin: -1, stale: true, failed: [],
    todayCross: Object.fromEntries(LEVELS.map((l) => [l, { up: [], down: [] }])),
    crossDay: "", crossDayIsCurrent: true, slopeBars: 0,
  };

  // The session's crossings, for the up/down matrix. Non-fatal: the levels are
  // the point of this tab, and an empty matrix is better than a 500.
  //
  // Walks back from the current SESSION day (which rolls at the open, not at
  // midnight) to the most recent partition that has anything in it, so the
  // matrix survives the overnight, the premarket and the weekend.
  const session = sessionDayStr();
  out.crossDay = session;
  try {
    for (let back = 0; back <= CROSS_LOOKBACK_DAYS; back++) {
      const day = back === 0 ? session : etDayMinus(session, back);
      const events = await listByPartition<Record<string, unknown>>(
        TABLES.AVWAP_EARNINGS, day);
      if (!events.length) continue;
      for (const e of events) {
        const level = String(e.level ?? "");
        const ticker = String(e.ticker ?? "");
        const bucket = out.todayCross[level];
        if (!bucket || !ticker) continue;
        const side = isDown(String(e.direction ?? "")) ? bucket.down : bucket.up;
        if (!side.includes(ticker)) side.push(ticker);
      }
      out.crossDay = day;
      break;
    }
  } catch { /* matrix renders empty */ }
  out.crossDayIsCurrent = out.crossDay === session;

  const entities = await listByPartition<Record<string, unknown>>(
    TABLES.AVWAP_EARNINGS, CURRENT_PK);

  for (const e of entities) {
    const rk = String(e.rowKey ?? "");
    if (rk === META_RK) {
      out.barUtc = String(e.barUtc ?? "");
      out.publishedAt = String(e.publishedAt ?? "");
      out.receivedAt = String(e.receivedAt ?? "");
      out.host = String(e.host ?? "");
      out.failed = String(e.failed ?? "").split(",").filter(Boolean);
      out.slopeBars = num(e.slopeBars) ?? 0;
      continue;
    }
    const levels: Record<string, number | null> = {};
    const pct: Record<string, number | null> = {};
    const slope: Record<string, number | null> = {};
    const slopeDir: Record<string, SlopeDirection | ""> = {};
    for (const level of LEVELS) {
      levels[level] = num(e[level]);
      const v = num(e[`pct_${level}`]);
      pct[level] = v === null ? null : Number(v.toFixed(2));
      const sl = num(e[`slope_${level}`]);
      slope[level] = sl === null ? null : Number(sl.toFixed(2));
      slopeDir[level] = classifySlope(sl);
    }
    out.rows.push({
      ticker: rk,
      sym: String(e.sym ?? ""),
      close: num(e.close) ?? 0,
      levels,
      pct,
      slope,
      slopeDir,
      lastCross: String(e.lastCross ?? ""),
      lastCrossAt: String(e.lastCrossAt ?? ""),
    });
  }

  out.rows.sort((a, b) => (b.pct.avwap ?? -Infinity) - (a.pct.avwap ?? -Infinity));

  if (out.publishedAt) {
    const t = Date.parse(out.publishedAt);
    if (Number.isFinite(t)) out.ageMin = Number(((Date.now() - t) / 60000).toFixed(1));
  }
  out.stale = isRthNow() && (out.ageMin < 0 || out.ageMin > staleMin());

  return out;
}
