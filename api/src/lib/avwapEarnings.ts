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
 * ── Alert rules (operator, 2026-08-15) ────────────────────────────────────
 *
 *   CROSS_UP    the candle CLOSES above the level and the PREVIOUS candle
 *               closed below it. Fires for all three levels.
 *   TOUCH_DOWN  a name that was extended ABOVE the AVWAP comes back down and
 *               touches it. AVWAP only — this is the mean-reversion leg, kept
 *               alongside the cross-up rules rather than replaced by them.
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

import { upsert, getOne, listByPartition, TABLES } from "./tables.js";
import { notifyBoth } from "./notifyBoth.js";

export const CURRENT_PK = "current";
export const META_RK = "__meta__";

const DEFAULT_CROSS_MIN_PCT = 0.25;
const DEFAULT_STALE_MIN = 15;

export const LEVELS = ["avwap", "ema21", "sma50"] as const;
export type Level = (typeof LEVELS)[number];
export type CrossDirection = "CROSS_UP" | "TOUCH_DOWN";

export const LEVEL_LABEL: Record<Level, string> = {
  avwap: "AVWAP(Earnings)",
  ema21: "21 EMA",
  sma50: "50 SMA",
};

export interface AvwapInputRow {
  ticker?: string;
  close?: number;
  avwap?: number; ema21?: number | null; sma50?: number | null;
  pct_avwap?: number; pct_ema21?: number | null; pct_sma50?: number | null;
  last_bar_closed?: boolean;
  closed_time?: number; prev_time?: number;
  closed_close?: number; prev_close?: number;
  c_pct_avwap?: number | null; p_pct_avwap?: number | null;
  c_pct_ema21?: number | null; p_pct_ema21?: number | null;
  c_pct_sma50?: number | null; p_pct_sma50?: number | null;
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
  close: number;
  avwap: number; ema21: number | null; sma50: number | null;
  pctAvwap: number; pctEma21: number | null; pctSma50: number | null;
  lastCross: string;       // e.g. "ema21:CROSS_UP"
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
}

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
 * The whole alert rule, in one pure function. Exported for unit tests.
 *
 * `prevPct` is the PREVIOUS closed candle's distance from the level and `pct`
 * the latest closed candle's. `allowTouchDown` is true only for the AVWAP.
 */
export function classifyCross(
  prevPct: number | null | undefined,
  pct: number | null | undefined,
  allowTouchDown: boolean,
  minPct: number = crossMinPct(),
): CrossDirection | "" {
  if (prevPct === null || prevPct === undefined || !Number.isFinite(prevPct)) return "";
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "";
  if (Math.abs(prevPct) < minPct) return "";
  if (prevPct < 0 && pct >= 0) return "CROSS_UP";
  if (allowTouchDown && prevPct > 0 && pct <= 0) return "TOUCH_DOWN";
  return "";
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function etDayStr(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export interface RecordResult {
  stored: number;
  skipped: number;
  crossings: CrossEvent[];
}

export async function recordSnapshot(
  rows: AvwapInputRow[],
  opts: { barUtc: string; publishedAt: string; host: string; failed: string[] },
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

  for (const raw of rows) {
    const ticker = String(raw.ticker ?? "").trim().toUpperCase();
    const close = num(raw.close);
    const avwap = num(raw.avwap);
    if (!ticker || close === null || avwap === null || avwap <= 0) {
      skipped++;
      continue;
    }

    const ema21 = num(raw.ema21);
    const sma50 = num(raw.sma50);
    const pctAvwap = num(raw.pct_avwap) ?? ((close - avwap) / avwap) * 100;

    const entity: Record<string, unknown> = {
      ticker,
      close,
      avwap, ema21, sma50,
      pctAvwap: Number(pctAvwap.toFixed(4)),
      pctEma21: num(raw.pct_ema21),
      pctSma50: num(raw.pct_sma50),
      side: pctAvwap >= 0 ? "ABOVE" : "BELOW",
      barUtc: opts.barUtc,
      publishedAt: opts.publishedAt || nowIso,
      receivedAt: nowIso,
      host: opts.host,
    };

    // ── crossings, decided from the publisher's two CLOSED bars ──────────
    const barTime = num(raw.closed_time) ?? 0;
    const closedClose = num(raw.closed_close) ?? close;
    const perLevel: Record<Level, { c: number | null; p: number | null; value: number | null }> = {
      avwap: { c: num(raw.c_pct_avwap), p: num(raw.p_pct_avwap), value: avwap },
      ema21: { c: num(raw.c_pct_ema21), p: num(raw.p_pct_ema21), value: ema21 },
      sma50: { c: num(raw.c_pct_sma50), p: num(raw.p_pct_sma50), value: sma50 },
    };

    let newestCross: { key: string; at: string } | null = null;

    for (const level of LEVELS) {
      const { c, p, value } = perLevel[level];
      const dir = classifyCross(p, c, level === "avwap", minPct);
      if (!dir || barTime <= 0) continue;
      if (await alreadyAlerted(ticker, level, dir, barTime)) continue;

      crossings.push({
        ticker, level, direction: dir,
        prevPct: p as number, pct: c as number,
        close: closedClose, levelValue: value ?? 0, barTime,
      });
      newestCross = { key: `${level}:${dir}`, at: nowIso };

      await upsert(
        TABLES.AVWAP_EARNINGS,
        etDayStr(),
        `${nowIso.slice(11, 19).replace(/:/g, "")}-${ticker}-${level}`,
        {
          ticker, level, direction: dir,
          prevPct: Number((p as number).toFixed(4)),
          pct: Number((c as number).toFixed(4)),
          close: closedClose, levelValue: value ?? 0,
          barTime, barIso: new Date(barTime * 1000).toISOString(),
          firedAt: nowIso, host: opts.host,
        },
      );
    }

    if (newestCross) {
      entity.lastCross = newestCross.key;
      entity.lastCrossAt = newestCross.at;
    } else {
      const prevRow = previous[ticker];
      if (prevRow?.lastCross) entity.lastCross = prevRow.lastCross;
      if (prevRow?.lastCrossAt) entity.lastCrossAt = prevRow.lastCrossAt;
    }

    await upsert(TABLES.AVWAP_EARNINGS, CURRENT_PK, ticker, entity);
    stored++;
  }

  await upsert(TABLES.AVWAP_EARNINGS, CURRENT_PK, META_RK, {
    barUtc: opts.barUtc,
    publishedAt: opts.publishedAt || nowIso,
    receivedAt: nowIso,
    host: opts.host,
    count: stored,
    // A dead feed must never look like a quiet market — carry the publisher's
    // own failure list through to the tab.
    failed: opts.failed.join(",").slice(0, 30000),
    failedCount: opts.failed.length,
  });

  if (crossings.length) {
    await alertCrossings(crossings);
    for (const c of crossings) {
      await markAlerted(c.ticker, c.level, c.direction, c.barTime);
    }
  }

  return { stored, skipped, crossings };
}

/** Dedup is per BAR, so a later genuine re-cross still alerts. */
function alertKey(ticker: string, level: Level, dir: string, barTime: number): [string, string] {
  return [`alert-${etDayStr()}`, `${ticker}-${level}-${dir}-${barTime}`];
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

/** One message per sweep — never one per ticker. */
async function alertCrossings(events: CrossEvent[]): Promise<void> {
  const lines: string[] = [];
  for (const level of LEVELS) {
    const ups = events.filter((e) => e.level === level && e.direction === "CROSS_UP");
    if (ups.length) {
      lines.push(`Closed above ${LEVEL_LABEL[level]}: ` +
        ups.map((e) => `${e.ticker} ${e.close}`).join(", "));
    }
  }
  const downs = events.filter((e) => e.direction === "TOUCH_DOWN");
  if (downs.length) {
    lines.push("Touched AVWAP from above: " +
      downs.map((e) => `${e.ticker} ${e.close}`).join(", "));
  }
  try {
    await notifyBoth(
      `AVWAP/EMA cross — ${events.length} signal(s)`,
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
  };

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
      continue;
    }
    const pctAvwap = num(e.pctAvwap) ?? 0;
    const r21 = num(e.pctEma21);
    const r50 = num(e.pctSma50);
    out.rows.push({
      ticker: rk,
      close: num(e.close) ?? 0,
      avwap: num(e.avwap) ?? 0,
      ema21: num(e.ema21),
      sma50: num(e.sma50),
      pctAvwap: Number(pctAvwap.toFixed(2)),
      pctEma21: r21 === null ? null : Number(r21.toFixed(2)),
      pctSma50: r50 === null ? null : Number(r50.toFixed(2)),
      lastCross: String(e.lastCross ?? ""),
      lastCrossAt: String(e.lastCrossAt ?? ""),
    });
  }

  out.rows.sort((a, b) => b.pctAvwap - a.pctAvwap);

  if (out.publishedAt) {
    const t = Date.parse(out.publishedAt);
    if (Number.isFinite(t)) out.ageMin = Number(((Date.now() - t) / 60000).toFixed(1));
  }
  out.stale = isRthNow() && (out.ageMin < 0 || out.ageMin > staleMin());

  return out;
}
