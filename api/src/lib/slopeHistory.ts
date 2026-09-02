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
 * The lookback is counted in BARS, walking back through the stored sequence —
 * NOT in clock time. A session is ten 39-minute bars, so fifteen bars back
 * always crosses a night; `now − 15 × 39min` lands in the small hours where no
 * bar exists and matches nothing. That was shipped once and produced a slope
 * that was null forever.
 *
 * A missed sweep is still a real hazard, because counting entries through a
 * hole measures a longer window than asked for while reporting the asked-for
 * one. So the window is rejected outright when two consecutive bars inside it
 * fall on the same ET day more than GAP_TOLERANCE bars apart. Overnight and
 * weekend gaps land on different days and are expected; a hole inside a session
 * is not. Either way the answer is null — an unknown slope, never one quietly
 * measured over the wrong span.
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
 * How much longer than one bar two CONSECUTIVE stored bars may sit apart before
 * we call it a missed sweep. Anything under this is clock jitter; anything over
 * means a bar is absent from the window.
 *
 * Applies only WITHIN a trading day. The overnight gap between one session's
 * last bar and the next session's first is ~17 hours and entirely expected.
 */
export const GAP_TOLERANCE = 1.5;

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

/** ET calendar date of a bar — the boundary an overnight gap sits on. */
function etDay(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Percent change of one level between `bars` ago and now, or null.
 *
 * `nowValue` is passed in rather than read from the history because the current
 * bar is being written in the same pass — the caller has it before it is stored.
 *
 * ── Counted in BARS, not in clock time ────────────────────────────────────
 * The obvious implementation — target = now − bars × barSeconds, then match the
 * nearest stored bar — is WRONG, and shipped wrong once. A session is only ten
 * 39-minute bars, so fifteen bars back always crosses at least one overnight
 * gap. Fifteen bars back and 9.75 hours back are 38 hours apart in real bar
 * times, nothing lands near the target, and the function returns null forever.
 *
 * So walk back `bars` ENTRIES through the stored sequence, which is already in
 * trading-time order and naturally skips nights and weekends.
 *
 * The reason clock matching was reached for in the first place still stands: a
 * missed sweep leaves a gap, and counting entries through one measures a longer
 * window than asked for while reporting the asked-for one. That is handled
 * directly — the window is rejected if any two consecutive bars inside it sit
 * on the SAME ET day more than GAP_TOLERANCE bars apart. Overnight and weekend
 * gaps land on different days and are expected; a hole inside a session is not.
 *
 * Returns null when: too few bars are stored yet (the warm-up), a bar is missing
 * inside the window, the level is absent at either end, or the earlier value is
 * not positive.
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

  // Never look forward, and never let the current bar count as its own history.
  const past = points.filter((p) => p.t < nowBarTime).sort((a, b) => a.t - b.t);
  if (past.length < bars) return null;                    // still warming up

  const window = past.slice(past.length - bars);          // the `bars` most recent
  const then = window[0].v[level];
  if (!isNum(then) || then <= 0) return null;

  // A hole inside the window would silently widen it. Check every adjacent pair,
  // including the step from the last stored bar to the bar being scored now.
  const seq = [...window.map((p) => p.t), nowBarTime];
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1], cur = seq[i];
    if (etDay(prev) !== etDay(cur)) continue;             // overnight — expected
    if (cur - prev > barSeconds * GAP_TOLERANCE) return null;
  }

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
