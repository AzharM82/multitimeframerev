/**
 * Opening Drive — the gate and trigger math (spec §PHASE 2 STEP A / STEP B).
 *
 * Pure functions, no I/O. This is the SINGLE SOURCE OF TRUTH for the trigger
 * logic: the replay engine and the live-ingestion validator both call it, and
 * the unit tests + the three acceptance replays pin it. The DESKTOP2 thinkScript
 * study reimplements the same rules for the live chart (chart-truth), and replay
 * is the independent cross-check that the two agree.
 */

import type { OpeningDriveConfig } from "./config.js";

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number; // epoch ms, bar-open time
}

// ─── The gate (spec §STEP A) ────────────────────────────────────────────────

export type GateMode = "strict" | "gap";

export interface GateResult {
  pass: boolean;
  reason: string;
  /** True when the open also cleared yesterday's high — a strength tier, not a
   *  requirement in "gap" mode. */
  clearedYdayHigh: boolean;
}

/**
 * Evaluated on the official 9:30 opening print.
 *
 *   "strict" — SMB classic: open must clear BOTH yesterday's high and the prior
 *              close, or the name is eliminated (no alert).
 *   "gap"    — loosened (default): open above the prior close is sufficient. A
 *              gap-and-go that has not yet reclaimed yesterday's high still
 *              qualifies, and the real signal (a 2-min close over the pre-market
 *              high) still has to fire downstream. Clearing yesterday's high is
 *              reported as a strength tier via clearedYdayHigh.
 *
 * Motivated by a real case: RGTI 2025-05-22 opened 11.03 (above prior close
 * 10.96, below yday high 12.07) and ran to 14.44 — the strict gate would have
 * rejected a genuine opening drive.
 */
export function evaluateGate(
  openPrice: number,
  ydayHigh: number,
  priorClose: number,
  mode: GateMode = "gap",
): GateResult {
  const clearedYdayHigh = openPrice > ydayHigh;

  if (!(openPrice > priorClose)) {
    return { pass: false, reason: `open ${openPrice} <= prior_close ${priorClose}`, clearedYdayHigh };
  }
  if (mode === "strict" && !clearedYdayHigh) {
    return { pass: false, reason: `open ${openPrice} <= yday_high ${ydayHigh} (strict)`, clearedYdayHigh };
  }

  const tier = clearedYdayHigh ? "cleared yday_high" : "gap over prior_close (below yday_high)";
  return { pass: true, reason: `open ${openPrice} > prior_close ${priorClose} — ${tier}`, clearedYdayHigh };
}

// ─── The trigger (spec §STEP B) ─────────────────────────────────────────────

export interface TriggerCheck {
  fired: boolean;
  stuffed: boolean; // wicked above PMH but closed below — visible, no alert
  body: number;
  upperWick: number;
  rvol: number;
  reasons: string[]; // which conditions passed/failed, for the audit log
}

/**
 * Evaluated on each COMPLETED 2-minute bar. Fires when ALL hold:
 *   1. bar_close > pm_high            (close above, not merely touch)
 *   2. bar_close > bar_open           (green body)
 *   3. upper_wick <= maxWickRatio*body
 *   4. rvol >= min_rvol
 * "Stuffed" = wicked above PMH but closed back below: shown in UI, no alert,
 * ticker stays live.
 */
export function evaluateTrigger(
  bar: Bar,
  pmHigh: number,
  rvol: number,
  cfg: OpeningDriveConfig,
): TriggerCheck {
  const body = bar.close - bar.open;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const reasons: string[] = [];

  const closeAbove = bar.close > pmHigh;
  const green = bar.close > bar.open;
  // A doji/red body has body <= 0; the wick filter is only meaningful on a
  // green body, and a non-green bar already fails condition 2.
  const wickOk = green && upperWick <= cfg.maxWickRatio * body;
  const rvolOk = rvol >= cfg.minRvol;

  reasons.push(`close>PMH: ${closeAbove} (${bar.close} vs ${pmHigh})`);
  reasons.push(`green: ${green} (body ${body.toFixed(4)})`);
  reasons.push(`wick<=${cfg.maxWickRatio}*body: ${wickOk} (wick ${upperWick.toFixed(4)})`);
  reasons.push(`rvol>=${cfg.minRvol}: ${rvolOk} (${rvol.toFixed(2)})`);

  const fired = closeAbove && green && wickOk && rvolOk;
  const stuffed = !fired && bar.high > pmHigh && bar.close <= pmHigh;

  return { fired, stuffed, body, upperWick, rvol, reasons };
}

// ─── RVOL time-of-day slot averaging (spec §STEP B) ─────────────────────────

/**
 * rvol_tod = this bar's volume / average volume of the SAME 2-min slot over the
 * prior N trading days. Slot identity is minutes-from-midnight-ET, so the
 * 9:30–9:32 bar is compared only with prior 9:30–9:32 bars.
 *
 * `priorSlotVolumes` is the list of that slot's volumes on prior days. Returns 0
 * when there is no history, so the caller decides how to treat an unknowable
 * RVOL (the live engine can fall back to the thinkScript's own RelVol).
 */
export function rvolTod(barVolume: number, priorSlotVolumes: number[]): number {
  const usable = priorSlotVolumes.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length === 0) return 0;
  const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
  if (avg <= 0) return 0;
  return barVolume / avg;
}

// ─── 2-minute bar alignment (spec §STEP B, tests §2-min alignment) ──────────

/** Minutes-from-midnight in America/New_York for an epoch-ms timestamp. */
export function etMinutes(timestampMs: number): number {
  const hhmm = new Date(timestampMs).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * True when a bar-open timestamp sits on a 2-minute boundary aligned to the 9:30
 * session open (9:30, 9:32, 9:34, …). 570 = 9:30 in ET minutes.
 */
export function isAlignedBarOpen(timestampMs: number, barMinutes = 2): boolean {
  const mins = etMinutes(timestampMs);
  return (mins - 570) % barMinutes === 0;
}

/**
 * Roll 1-minute candles into aligned N-minute bars for the regular session.
 * Grouping is by the aligned bar-open minute so the 9:30 boundary is exact and
 * an odd leading minute never smears two sessions together.
 */
export function rollToBars(oneMin: Bar[], barMinutes = 2): Bar[] {
  const buckets = new Map<number, Bar[]>();
  for (const c of oneMin) {
    const mins = etMinutes(c.timestamp);
    if (mins < 570 || mins >= 960) continue; // RTH only, 9:30–16:00
    const bucketStart = 570 + Math.floor((mins - 570) / barMinutes) * barMinutes;
    // Key on the calendar day too, so multi-day input never collides.
    const dayKey = new Date(c.timestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const key = Number(dayKey.replace(/-/g, "")) * 10000 + bucketStart;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }

  const out: Bar[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(key)!.sort((a, b) => a.timestamp - b.timestamp);
    out.push({
      open: group[0].open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
      timestamp: group[0].timestamp,
    });
  }
  return out;
}
