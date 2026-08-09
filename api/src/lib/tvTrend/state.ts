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

export async function readState(): Promise<StreakState> {
  const row = await getOne<Partial<StreakState>>(TABLES.TV_TREND, PARTITION, ROW);
  if (!row) return { ...EMPTY };
  return {
    position: (row.position as Position) ?? "FLAT",
    since: row.since ?? "",
    entryRegime: row.entryRegime ?? "",
    lastEvent: row.lastEvent ?? "",
    updatedAt: row.updatedAt ?? "",
  };
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
