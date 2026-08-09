import { upsert, getOne, TABLES } from "../tables.js";

/**
 * Which streak the receiver currently believes is running.
 *
 * WHY THIS EXISTS (2026-08-09): the TradingView side moved from one Pine
 * `alert()` — which fired exactly twice per trend by construction — to four
 * native alerts on "Once Per Bar Close". That setting fires at the close of
 * EVERY bar on which its condition holds. If those conditions are level-based
 * ("a green trend is active") rather than edge-based ("a green trend just
 * started"), the same event repeats every 5 minutes for the life of the trend.
 *
 * The bucket dedup in the webhook cannot catch that: successive bars are
 * different 5-minute buckets, so each looks like a fresh event.
 *
 * So the receiver enforces the semantics itself — an event identical to the
 * last one it acted on is a REPEAT: still recorded, never re-notified. That
 * makes "twice per trend" true regardless of how the alerts are configured,
 * which matters because we do not control that side and cannot see it change.
 *
 * Deliberately a "no two consecutive identical events" rule rather than a
 * strict start/end state machine: a flip (green start straight into red start)
 * and a genuine end-without-a-start we never saw both still notify. Only the
 * literal repeat is suppressed.
 */

const PARTITION = "state";
const ROW = "current";

export interface StreakState {
  /** "<trend>:<event>" of the last event that actually notified. */
  lastEvent: string;
  /** Streak believed to be running, or "" when flat. */
  activeTrend: "green" | "red" | "";
  /** When that streak started — lets an END report how long it ran. */
  activeSince: string;
  updatedAt: string;
}

export async function readState(): Promise<StreakState> {
  const row = await getOne<Partial<StreakState>>(TABLES.TV_TREND, PARTITION, ROW);
  return {
    lastEvent: row?.lastEvent ?? "",
    activeTrend: (row?.activeTrend as StreakState["activeTrend"]) ?? "",
    activeSince: row?.activeSince ?? "",
    updatedAt: row?.updatedAt ?? "",
  };
}

export async function writeState(s: StreakState): Promise<void> {
  await upsert(TABLES.TV_TREND, PARTITION, ROW, { ...s });
}

export const eventKey = (trend: string, event: string) => `${trend}:${event}`;

/** Advance the believed state for an event we are about to act on. */
export function nextState(
  prev: StreakState,
  trend: "green" | "red",
  event: "trend_start" | "trend_end",
  nowIso: string,
): StreakState {
  if (event === "trend_start") {
    return { lastEvent: eventKey(trend, event), activeTrend: trend, activeSince: nowIso, updatedAt: nowIso };
  }
  // An END only clears the position if it matches what we thought was running;
  // an END for the other colour leaves that streak alone.
  const clears = prev.activeTrend === trend;
  return {
    lastEvent: eventKey(trend, event),
    activeTrend: clears ? "" : prev.activeTrend,
    activeSince: clears ? "" : prev.activeSince,
    updatedAt: nowIso,
  };
}

/** "ran 35m" for an END we saw the start of, else null. */
export function ranFor(prev: StreakState, trend: string, startedAtMs: number): string | null {
  if (prev.activeTrend !== trend || !prev.activeSince) return null;
  const t = Date.parse(prev.activeSince);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((startedAtMs - t) / 60_000);
  if (mins < 1) return "ran <1m";
  if (mins < 60) return `ran ${mins}m`;
  return `ran ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}
