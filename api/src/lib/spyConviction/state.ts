import { upsert, getOne, TABLES } from "../tables.js";
import type { Signal } from "./models.js";

/**
 * The position lifecycle the indicator drives:
 *
 *   STAND_ASIDE -> ARM_CALL/ARM_PUT -> BUY_* -> HOLD_* / REDUCE_* -> SELL_* -> flat
 *                        |
 *                        +-> ARM_CANCEL -> flat
 *
 * ALERTS-ONLY. This is a BELIEF about what the operator is holding, never a
 * broker fact — every trade is placed by hand. If one is skipped the belief
 * drifts, which is what `?flat=1` is for.
 */

export type ConvictionState = "FLAT" | "ARMED_CALL" | "ARMED_PUT" | "LONG_CALL" | "LONG_PUT";

/**
 * signal -> (states it is legal from, resulting state)
 *
 * STAND_ASIDE is legal from anywhere and always lands FLAT: it is the
 * indicator's idle heartbeat, and the indicator is authoritative about its own
 * state. Arriving while we believe a position is open is still recorded as an
 * anomaly — it means an exit went missing — but we follow it rather than
 * clinging to a position the source says is gone.
 */
const TRANSITIONS: Record<Signal, { from: ConvictionState[]; to: ConvictionState }> = {
  ARM_CALL:    { from: ["FLAT"], to: "ARMED_CALL" },
  ARM_PUT:     { from: ["FLAT"], to: "ARMED_PUT" },
  ARM_CANCEL:  { from: ["ARMED_CALL", "ARMED_PUT"], to: "FLAT" },
  BUY_CALL:    { from: ["ARMED_CALL"], to: "LONG_CALL" },
  BUY_PUT:     { from: ["ARMED_PUT"], to: "LONG_PUT" },
  HOLD_CALL:   { from: ["LONG_CALL"], to: "LONG_CALL" },
  HOLD_PUT:    { from: ["LONG_PUT"], to: "LONG_PUT" },
  REDUCE_CALL: { from: ["LONG_CALL"], to: "LONG_CALL" },
  REDUCE_PUT:  { from: ["LONG_PUT"], to: "LONG_PUT" },
  SELL_CALL:   { from: ["LONG_CALL"], to: "FLAT" },
  SELL_PUT:    { from: ["LONG_PUT"], to: "FLAT" },
  STAND_ASIDE: { from: ["FLAT", "ARMED_CALL", "ARMED_PUT", "LONG_CALL", "LONG_PUT"], to: "FLAT" },
};

export interface Transition {
  from: ConvictionState;
  to: ConvictionState;
  anomaly: boolean;
  detail: string;
}

/**
 * Advance the machine. Never throws on a surprising signal — an out-of-order
 * transition is flagged and counted, and the alert still lands. A receiver that
 * rejects the unexpected loses every message after it, and the operator's phone
 * cannot tell that apart from a quiet market.
 */
export function applySignal(from: ConvictionState, signal: Signal): Transition {
  const rule = TRANSITIONS[signal];
  if (!rule) {
    return { from, to: from, anomaly: true, detail: `unknown signal ${signal} while ${from}` };
  }
  // STAND_ASIDE is only noteworthy when it contradicts a position we believe open.
  const anomaly = signal === "STAND_ASIDE" ? from !== "FLAT" : !rule.from.includes(from);
  return {
    from,
    to: rule.to,
    anomaly,
    detail: anomaly ? `${signal} arrived while ${from}` : "",
  };
}

// ── persistence ─────────────────────────────────────────────────────────────

const PARTITION = "cstate";
const ROW = "current";

export interface StoredState {
  state: ConvictionState;
  /** When the current state was entered (ISO), "" when flat. */
  since: string;
  lastSignal: string;
  lastBarTime: string;
  /** Score at the BUY, so an exit can say what it made or lost on conviction. */
  entryScore: number;
  entryPx: number;
  anomalies: number;
  updatedAt: string;
}

const EMPTY: StoredState = {
  state: "FLAT", since: "", lastSignal: "", lastBarTime: "",
  entryScore: 0, entryPx: 0, anomalies: 0, updatedAt: "",
};

const etDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function readState(): Promise<StoredState> {
  const row = await getOne<Partial<StoredState>>(TABLES.SPY_CONVICTION, PARTITION, ROW);
  if (!row) return { ...EMPTY };

  const s: StoredState = {
    state: (row.state as ConvictionState) ?? "FLAT",
    since: row.since ?? "",
    lastSignal: row.lastSignal ?? "",
    lastBarTime: row.lastBarTime ?? "",
    entryScore: Number(row.entryScore ?? 0),
    entryPx: Number(row.entryPx ?? 0),
    anomalies: Number(row.anomalies ?? 0),
    updatedAt: row.updatedAt ?? "",
  };

  /**
   * A belief does not survive the session.
   *
   * A stale ARMED_PUT carried into the next morning would make the first
   * ARM_PUT read as an out-of-order anomaly and the following BUY legal from a
   * state nobody chose. Being wrong in this direction costs one redundant ARM;
   * being wrong the other way corrupts a whole session's state.
   *
   * Read-time rather than a scheduled reset: no extra cron to fail, and it
   * self-heals even if the box was off for a week. The anomaly counter survives
   * on purpose — it is a running health signal, not a per-day one.
   */
  if (s.state !== "FLAT") {
    const then = s.updatedAt ? etDate(new Date(s.updatedAt)) : "";
    if (!then || then !== etDate(new Date())) {
      return { ...EMPTY, anomalies: s.anomalies, lastSignal: "auto-flat:new-session", updatedAt: s.updatedAt };
    }
  }
  return s;
}

export async function writeState(s: StoredState): Promise<void> {
  await upsert(TABLES.SPY_CONVICTION, PARTITION, ROW, { ...s });
}

/** Roll the belief forward after a transition. */
export function advance(
  prev: StoredState,
  t: Transition,
  signal: Signal,
  barTime: string,
  score: number | null,
  px: number | null,
  nowIso: string,
): StoredState {
  const entered = t.to !== prev.state;
  const opening = signal === "BUY_CALL" || signal === "BUY_PUT";
  return {
    state: t.to,
    since: t.to === "FLAT" ? "" : entered ? nowIso : prev.since,
    lastSignal: signal,
    lastBarTime: barTime,
    entryScore: t.to === "FLAT" ? 0 : opening ? (score ?? 0) : prev.entryScore,
    entryPx: t.to === "FLAT" ? 0 : opening ? (px ?? 0) : prev.entryPx,
    anomalies: prev.anomalies + (t.anomaly ? 1 : 0),
    updatedAt: nowIso,
  };
}

/** "held 35m" for a state we saw entered, else null. */
export function heldFor(prev: StoredState, nowMs: number): string | null {
  if (prev.state === "FLAT" || !prev.since) return null;
  const t = Date.parse(prev.since);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((nowMs - t) / 60_000);
  if (mins < 1) return "held <1m";
  if (mins < 60) return `held ${mins}m`;
  return `held ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}
