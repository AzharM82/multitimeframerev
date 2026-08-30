/**
 * A short rolling history of each level's plotted value, so the slope can be
 * derived from data we already receive.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Every sweep already tells us what the 5-day SMA is worth right now. It did
 * not tell us what it was worth 39 minutes ago, because `recordSnapshot`
 * upserts each ticker into the `current` partition — an overwrite. We held the
 * level and threw away its past, and a slope needs two points in time.
 *
 * The first implementation solved that at the source: the DESKTOP2 publisher
 * reads the plotted value 15 bars back off the chart and sends it. That is
 * exact from the very first sweep, but it made a cloud tab depend on a desktop
 * pulling a git change. This module is the fallback — keep the values we are
 * already given, and the slope falls out with no publisher change at all.
 *
 * ── Where the history lives ───────────────────────────────────────────────
 * As ONE compact string on the ticker's existing `current` row, not a separate
 * partition. `recordSnapshot` already loads that partition to compute the prune,
 * so the history arrives at zero extra reads and costs zero extra writes.
 * Twenty-four points is ~500 bytes, far inside Table Storage's 64KB property
 * limit.
 *
 * ── The rule that matters ─────────────────────────────────────────────────
 * A point is matched by its BAR TIME, never by its position in the array. A
 * missed sweep leaves a gap, and counting backwards N entries through a gap
 * measures a longer window than asked for while reporting the asked-for one.
 * When no stored bar sits near the target, the answer is null — an unknown
 * slope, not one quietly measured over the wrong span.
 *
 * PURE. No I/O, no clock. Exercised by api/tools/spread-math-test.mjs's sibling
 * assertions in avwap-rules-test.mjs.
 */

import { LEVELS, type Level } from "./avwapEarnings.js";

/** 39-minute bars — the resolution the whole AVWAP tab is built on. */
export const BAR_SECONDS = 39 * 60;

/** How many bars to retain. 24 covers a 15-bar lookback plus slack for gaps. */
export const HIST_MAX = 24;

/**
 * How far a stored bar may sit from the target and still be used, as a fraction
 * of one bar. Half a bar means "the nearest bar, and only if it really is the
 * one we meant" — beyond that the window is wrong and null is the honest answer.
 */
export const HIST_TOLERANCE = 0.5;

export interface HistPoint {
  /** Bar epoch SECONDS, matching the publisher's closed-bar time. */
  t: number;
  /** Plotted value per level; null where the level was absent on that bar. */
  v: Record<string, number | null>;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const r4 = (n: number) => Number(n.toFixed(4));

/**
 * Decode `t:avwap:sma50:ema21d:sma50d;t:...` — positional, semicolon-separated,
 * empty field for a missing level.
 *
 * Never throws. A history that cannot be read is treated as no history, because
 * this is a convenience layer and a malformed string must not take down a sweep
 * that is otherwise fine.
 */
export function parseHist(raw: unknown): HistPoint[] {
  if (typeof raw !== "string" || !raw) return [];
  const out: HistPoint[] = [];
  for (const chunk of raw.split(";")) {
    if (!chunk) continue;
    const parts = chunk.split(":");
    const t = Number(parts[0]);
    if (!isNum(t) || t <= 0) continue;
    const v: Record<string, number | null> = {};
    LEVELS.forEach((lv, i) => {
      const raw = parts[i + 1];
      const n = raw === undefined || raw === "" ? NaN : Number(raw);
      v[lv] = Number.isFinite(n) ? n : null;
    });
    out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function encodeHist(points: HistPoint[]): string {
  return points
    .map((p) => [p.t, ...LEVELS.map((lv) => {
      const n = p.v[lv];
      return isNum(n) ? Number(n.toFixed(4)) : "";
    })].join(":"))
    .join(";");
}

/**
 * Add this bar, keeping one entry per bar time and the newest `max`.
 *
 * Re-scoring the same bar REPLACES rather than appends: a sweep that runs twice
 * on one bar must not consume two history slots and shorten the lookback.
 */
export function appendHist(prev: HistPoint[], point: HistPoint, max = HIST_MAX): HistPoint[] {
  if (!isNum(point.t) || point.t <= 0) return prev.slice(-max);
  const kept = prev.filter((p) => p.t !== point.t);
  kept.push(point);
  kept.sort((a, b) => a.t - b.t);
  return kept.slice(-max);
}

/**
 * Percent change of one level between `bars` ago and now, or null.
 *
 * `nowValue` is passed in rather than read from the history because the current
 * bar is being written in the same pass — the caller has it before it is stored.
 *
 * Returns null when: the level is missing at either end, the earlier value is
 * not positive, or no stored bar lies within HIST_TOLERANCE of the target time.
 * That last case is the important one — see the module header.
 */
export function slopeFromHist(
  points: HistPoint[],
  level: Level,
  nowBarTime: number,
  nowValue: number | null,
  bars: number,
  barSeconds = BAR_SECONDS,
): number | null {
  if (!isNum(nowValue) || nowValue <= 0) return null;
  if (!isNum(nowBarTime) || nowBarTime <= 0) return null;
  if (!isNum(bars) || bars < 1) return null;

  const target = nowBarTime - bars * barSeconds;
  const tolerance = barSeconds * HIST_TOLERANCE;

  let best: HistPoint | null = null;
  let bestGap = Infinity;
  for (const p of points) {
    if (p.t >= nowBarTime) continue;          // never look forward
    const gap = Math.abs(p.t - target);
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  if (!best || bestGap > tolerance) return null;

  const then = best.v[level];
  if (!isNum(then) || then <= 0) return null;
  return r4(((nowValue - then) / then) * 100);
}

/**
 * How many more bars until a slope can be produced, for the UI's benefit.
 * Zero once the window is covered. Purely informational.
 */
export function barsUntilSlope(points: HistPoint[], bars: number): number {
  if (!isNum(bars) || bars < 1) return 0;
  return Math.max(0, bars - points.length);
}
