import { upsert, getOne, TABLES } from "../tables.js";
import type { Position } from "./decide.js";

/**
 * What the receiver believes the operator is holding, and since when.
 *
 * ALERTS-ONLY, so this is a BELIEF, not a broker fact — the operator places
 * every trade by hand. If they skip one, this drifts, which is why
 * `POST /api/tv-trend-webhook?flat=1` exists to force it back to FLAT.
 *
 * There is deliberately no end-of-day reset (operator, 2026-08-09: "signal
 * driven only"), so a position carries across sessions until a streak or a
 * regime flip closes it. The trade-off is accepted: the state can be stale
 * overnight, and force-flat is the correction.
 *
 * Note this file no longer suppresses repeated events by itself. The position
 * machine in decide.ts subsumes that and does it better: a second identical
 * event produces no position change, so it is silent for the right reason
 * rather than because a key matched.
 */

const PARTITION = "state";
const ROW = "current";

export interface StreakState {
  position: Position;
  /** When the current position was opened (ISO), "" when flat. */
  since: string;
  /** Regime label at entry — lets an exit say what changed. */
  entryRegime: string;
  /** Last event acted on, for diagnostics only. */
  lastEvent: string;
  updatedAt: string;
}

const EMPTY: StreakState = { position: "FLAT", since: "", entryRegime: "", lastEvent: "", updatedAt: "" };

const etDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function readState(): Promise<StreakState> {
  const row = await getOne<Partial<StreakState>>(TABLES.TV_TREND, PARTITION, ROW);
  if (!row) return { ...EMPTY };
  const state: StreakState = {
    position: (row.position as Position) ?? "FLAT",
    since: row.since ?? "",
    entryRegime: row.entryRegime ?? "",
    lastEvent: row.lastEvent ?? "",
    updatedAt: row.updatedAt ?? "",
  };

  /**
   * A belief does not survive the session.
   *
   * This is an ALERTING system — it places nothing, and the operator is flat by
   * the end of the day. If a stale "CALLS" carried into the next morning, the
   * first green_start would read as "already long, nothing changed" and send
   * NOTHING. A missed entry alert is the one failure mode that is invisible:
   * silence looks identical to "no signal yet".
   *
   * So a position from an earlier ET trading date reads as FLAT. Being wrong in
   * this direction costs at most one redundant ENTER alert, which is obvious and
   * ignorable; being wrong the other way costs a signal you never knew existed.
   *
   * Read-time rather than a scheduled reset on purpose: no extra cron to fail,
   * and it self-heals even if the box was off for a week.
   */
  if (state.position !== "FLAT") {
    const then = state.updatedAt ? etDate(new Date(state.updatedAt)) : "";
    if (!then || then !== etDate(new Date())) {
      return { ...EMPTY, lastEvent: "auto-flat:new-session", updatedAt: state.updatedAt };
    }
  }
  return state;
}

export async function writeState(s: StreakState): Promise<void> {
  await upsert(TABLES.TV_TREND, PARTITION, ROW, { ...s });
}

/** Roll the belief forward after a decision. */
export function advance(
  prev: StreakState,
  next: Position,
  lastEvent: string,
  regimeLabel: string,
  nowIso: string,
): StreakState {
  const opened = next !== "FLAT" && prev.position !== next;
  return {
    position: next,
    since: next === "FLAT" ? "" : opened ? nowIso : prev.since,
    entryRegime: next === "FLAT" ? "" : opened ? regimeLabel : prev.entryRegime,
    lastEvent,
    updatedAt: nowIso,
  };
}

/** "held 35m" for a position we saw open, else null. */
export function heldFor(prev: StreakState, nowMs: number): string | null {
  if (prev.position === "FLAT" || !prev.since) return null;
  const t = Date.parse(prev.since);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((nowMs - t) / 60_000);
  if (mins < 1) return "held <1m";
  if (mins < 60) return `held ${mins}m`;
  return `held ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}
