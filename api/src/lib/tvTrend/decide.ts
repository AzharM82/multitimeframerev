import type { RegimeDirection, GateDecision } from "./regime.js";

/**
 * The position state machine — the "layer of intelligence on our side".
 *
 * TradingView keeps sending all four raw events (green/red × start/end). What
 * they MEAN depends on the Gate regime, and that mapping lives here rather than
 * in the alerts, because we can change it without touching TradingView.
 *
 * Operator's rules, 2026-08-09:
 *
 *   TRENDING DAY — ride the trend, exit on the OPPOSITE streak.
 *     bullish: green_start enters calls; green_end is only a PAUSE (hold);
 *              red_start is the exit. A red streak does NOT open puts —
 *              counter-trend entries stay banned (the aligned-only rule).
 *     bearish: mirror image.
 *
 *   CHOP DAY (Consolidation / Mixed) — follow the alert literally, both ways:
 *     enter on a streak start, exit on that same streak's end.
 *
 * The asymmetry is the point: on a directional day the streak ending is noise,
 * so exiting there churns you out of a move that is still running. On a
 * directionless day it is the whole signal.
 *
 * NOTIFICATION FOLLOWS POSITION CHANGE, not event arrival. A `green_end` on a
 * bullish day changes nothing, so it stays silent. That is what groups the four
 * raw alerts down to actual decisions — and it makes repeated firing harmless
 * for free: a second `green_start` while already long is simply no change.
 *
 * NOTE: we are alerts-only. `position` is what we BELIEVE the operator holds,
 * not a broker fact. It can drift if they skip a trade — hence force-flat.
 */

export type Position = "FLAT" | "CALLS" | "PUTS";

export type Action =
  | "ENTER_CALLS"
  | "ENTER_PUTS"
  | "EXIT_CALLS"
  | "EXIT_PUTS"
  | "FLIP_TO_CALLS"
  | "FLIP_TO_PUTS"
  | "HOLD"
  | "NONE";

export interface Decision {
  action: Action;
  /** Position after this decision. */
  position: Position;
  /** Only a real position change is worth a message. */
  notify: boolean;
  why: string;
}

const d = (action: Action, position: Position, notify: boolean, why: string): Decision => ({ action, position, notify, why });

export interface DecideInput {
  trend: "green" | "red";
  event: "trend_start" | "trend_end";
  position: Position;
  /** null when we have no usable regime (missing or stale). */
  direction: RegimeDirection | null;
  gate: GateDecision | null;
  regimeLabel: string;
}

export function decide(input: DecideInput): Decision {
  const { trend, event, position, direction, gate, regimeLabel } = input;

  // No trustworthy regime, or the Gate has stood the day down: we may still
  // EXIT, but we must not open anything. An unknown regime is treated as
  // neutral for exits — holding on a thesis we cannot see is worse than being
  // flat, so a stale read shortens risk rather than extending it.
  const canEnter = direction !== null && gate !== "NO";
  const effective: RegimeDirection = direction ?? "neutral";
  const label = regimeLabel || "regime unknown";

  if (event === "trend_start") {
    const entering = trend === "green" ? "CALLS" : "PUTS";
    const opposite = trend === "green" ? "PUTS" : "CALLS";
    const wanted: RegimeDirection = trend === "green" ? "bullish" : "bearish";

    if (position === opposite) {
      // The opposite streak starting is what closes a trending-day position.
      if (effective === "neutral" && canEnter) {
        return d(
          trend === "green" ? "FLIP_TO_CALLS" : "FLIP_TO_PUTS",
          entering as Position,
          true,
          `${trend.toUpperCase()} streak started on a ${label} day — close ${opposite} and take ${entering}`,
        );
      }
      return d(
        trend === "green" ? "EXIT_PUTS" : "EXIT_CALLS",
        "FLAT",
        true,
        `${trend.toUpperCase()} streak started — that ends the ${opposite} trade (${label})`,
      );
    }

    if (position === entering) {
      return d("NONE", position, false, `already in ${entering} — nothing to do`);
    }

    // FLAT from here.
    if (!canEnter) {
      const reason = gate === "NO" ? `Gate says NO today — stand down` : `no trustworthy regime — not opening`;
      return d("NONE", "FLAT", false, reason);
    }
    if (effective === wanted || effective === "neutral") {
      const how = effective === "neutral" ? `${label} — trade the streak both ways` : `aligned with ${label}`;
      return d(
        trend === "green" ? "ENTER_CALLS" : "ENTER_PUTS",
        entering as Position,
        true,
        `${trend.toUpperCase()} streak started, ${how}${gate === "CAUTION" ? " [Gate: CAUTION]" : ""}`,
      );
    }
    // Counter-trend on a directional day: never an entry.
    return d("NONE", "FLAT", false, `${trend.toUpperCase()} streak is counter-trend to a ${label} day — no entry`);
  }

  // ── trend_end ────────────────────────────────────────────────────────────
  const held = trend === "green" ? "CALLS" : "PUTS";
  if (position !== held) {
    return d("NONE", position, false, `${trend.toUpperCase()} streak ended but we are not in ${held}`);
  }

  const trendingWithUs: RegimeDirection = trend === "green" ? "bullish" : "bearish";
  if (effective === trendingWithUs) {
    // The whole point of the rule change: a pause is not an exit.
    return d("HOLD", position, false, `${trend.toUpperCase()} streak ended but the day is still ${label} — staying in ${held}`);
  }

  return d(
    trend === "green" ? "EXIT_CALLS" : "EXIT_PUTS",
    "FLAT",
    true,
    `${trend.toUpperCase()} streak ended on a ${label} day — close ${held}`,
  );
}

/**
 * The regime itself turning against an open position.
 *
 * Checked on every regime refresh (every 15 min), not on a streak event — the
 * reason for holding can evaporate long before the opposite streak shows up,
 * and waiting for it can mean riding a dead thesis for an hour.
 *
 * Neutral is NOT "against": it does not exit, it just switches the day to the
 * chop rules, where the next trend_end closes the position anyway.
 */
export function decideOnRegimeChange(position: Position, direction: RegimeDirection, regimeLabel: string): Decision | null {
  if (position === "CALLS" && direction === "bearish") {
    return d("EXIT_CALLS", "FLAT", true, `regime flipped to ${regimeLabel} while long calls — the reason for the trade is gone`);
  }
  if (position === "PUTS" && direction === "bullish") {
    return d("EXIT_PUTS", "FLAT", true, `regime flipped to ${regimeLabel} while long puts — the reason for the trade is gone`);
  }
  return null;
}

/** What the operator should actually do, in the alert. */
export function actionLine(a: Action): string {
  switch (a) {
    case "ENTER_CALLS": return "BUY SPY CALLS";
    case "ENTER_PUTS": return "BUY SPY PUTS";
    case "EXIT_CALLS": return "CLOSE SPY CALLS";
    case "EXIT_PUTS": return "CLOSE SPY PUTS";
    case "FLIP_TO_CALLS": return "CLOSE PUTS → BUY SPY CALLS";
    case "FLIP_TO_PUTS": return "CLOSE CALLS → BUY SPY PUTS";
    case "HOLD": return "hold";
    default: return "no action";
  }
}
