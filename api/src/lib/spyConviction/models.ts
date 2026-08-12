/**
 * SPY Conviction Score — the alert payload from the Pine v6 indicator.
 *
 * Fires on closed 10-minute SPY bars. Six legs feed one score (Cum TICK, volume
 * pressure, SPY vs VWAP, SPY vs EMA9, SPY/RSP lead, VIX); `legs_agree` says how
 * many pointed the same way.
 *
 * Parsing is strict about the fields the state machine and the notification
 * depend on, and forgiving about everything else. The indicator gains columns as
 * it evolves, and a field it starts sending must never take the feed down —
 * unknown keys are carried, not rejected.
 */

export type Signal =
  | "ARM_CALL" | "ARM_PUT" | "ARM_CANCEL"
  | "BUY_CALL" | "BUY_PUT"
  | "HOLD_CALL" | "HOLD_PUT"
  | "REDUCE_CALL" | "REDUCE_PUT"
  | "SELL_CALL" | "SELL_PUT"
  | "STAND_ASIDE";

export type Action = "ARM" | "CANCEL" | "BUY" | "HOLD" | "REDUCE" | "SELL" | "FLAT";
export type Side = "CALL" | "PUT" | "NONE";

const SIGNALS = new Set<string>([
  "ARM_CALL", "ARM_PUT", "ARM_CANCEL", "BUY_CALL", "BUY_PUT", "HOLD_CALL",
  "HOLD_PUT", "REDUCE_CALL", "REDUCE_PUT", "SELL_CALL", "SELL_PUT", "STAND_ASIDE",
]);
const ACTIONS = new Set<string>(["ARM", "CANCEL", "BUY", "HOLD", "REDUCE", "SELL", "FLAT"]);
const SIDES = new Set<string>(["CALL", "PUT", "NONE"]);

/**
 * Actions worth interrupting a human for.
 *
 * HOLD and FLAT are the quiet majority — on 10-minute bars they fire all
 * session and would train the operator to ignore the channel, which is the only
 * real failure mode a notifier has.
 */
export const NOTIFY_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "ARM", "CANCEL", "BUY", "REDUCE", "SELL",
]);

export interface ConvictionAlert {
  strategy: string;
  signal: Signal;
  action: Action;
  side: Side;

  grade: string | null;
  bias: string | null;
  score: number | null;
  legsAgree: number | null;

  entryTrigger: string | null;
  entryDistAtr: number | null;
  extAtr: number | null;
  barsHeld: number | null;
  entryScore: number | null;
  entryPx: number | null;
  blockReason: string | null;

  /** The six legs behind the score, plus price context. */
  spy: number | null;
  vwap: number | null;
  ema9: number | null;
  atr: number | null;
  vix: number | null;
  tick: number | null;
  cvd: number | null;
  breadthRatio: number | null;

  tf: string | null;
  chartSymbol: string | null;
  /** Bar that produced the alert. Half the dedupe key, so it is required. */
  barTime: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export type ParseResult =
  | { ok: true; alert: ConvictionAlert }
  | { ok: false; reason: string };

/**
 * TradingView sends `Content-Type: text/plain` with a JSON body. Tolerate a BOM,
 * surrounding whitespace and stray wrapper text — but never guess at contents.
 */
export function parseConviction(raw: string): ParseResult {
  let obj: Record<string, unknown>;
  const text = raw.trim().replace(/^﻿/, "");
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a === -1 || b <= a) return { ok: false, reason: "body is not JSON" };
    try {
      obj = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "body is not JSON" };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "payload is not a JSON object" };
  }

  const signal = String(obj.signal ?? "").toUpperCase().trim();
  if (!SIGNALS.has(signal)) return { ok: false, reason: `unknown signal "${obj.signal}"` };

  const action = String(obj.action ?? "").toUpperCase().trim();
  if (!ACTIONS.has(action)) return { ok: false, reason: `unknown action "${obj.action}"` };

  const sideRaw = String(obj.side ?? "NONE").toUpperCase().trim();
  const side = (SIDES.has(sideRaw) ? sideRaw : "NONE") as Side;

  const barTime = str(obj.bar_time);
  if (!barTime) return { ok: false, reason: "bar_time is required (it is half the dedupe key)" };

  const strategy = str(obj.strategy) ?? "SPY_CONVICTION";

  return {
    ok: true,
    alert: {
      strategy,
      signal: signal as Signal,
      action: action as Action,
      side,
      grade: str(obj.grade),
      bias: str(obj.bias),
      score: num(obj.score),
      legsAgree: num(obj.legs_agree),
      entryTrigger: str(obj.entry_trigger),
      entryDistAtr: num(obj.entry_dist_atr),
      extAtr: num(obj.ext_atr),
      barsHeld: num(obj.bars_held),
      entryScore: num(obj.entry_score),
      entryPx: num(obj.entry_px),
      blockReason: str(obj.block_reason),
      spy: num(obj.spy),
      vwap: num(obj.vwap),
      ema9: num(obj.ema9),
      atr: num(obj.atr),
      vix: num(obj.vix),
      tick: num(obj.tick),
      cvd: num(obj.cvd),
      breadthRatio: num(obj.breadth_ratio),
      tf: str(obj.tf),
      chartSymbol: str(obj.chart_symbol),
      barTime,
    },
  };
}

/** Dedupe identity. TradingView retries; a retry must not notify twice. */
export const dedupeKey = (a: ConvictionAlert) => `${a.strategy}|${a.barTime}|${a.signal}`;

/** "2026-08-12 09:50:00" -> "09:50". Falls back to the raw string. */
export function barHHMM(barTime: string): string {
  const m = barTime.match(/\d{2}:\d{2}/);
  return m ? m[0] : barTime;
}

/**
 * One line, scannable on a lock screen:
 *   "BUY_PUT | score -67 6/6 | vwap_reclaim @0.12 ATR | SPY 770.45 | 09:50"
 *
 * Segments answer, in order: what, how convinced, why now, at what price, when.
 * Absent pieces are dropped rather than printed as null — a lock screen has no
 * room for missing data.
 */
export function formatAlert(a: ConvictionAlert): string {
  const parts: string[] = [a.signal];

  if (a.score !== null) {
    let s = `score ${a.score}`;
    if (a.legsAgree !== null) s += ` ${a.legsAgree}/6`;
    parts.push(s);
  }

  if (a.entryTrigger && a.entryTrigger !== "none") {
    let t = a.entryTrigger;
    if (a.entryDistAtr !== null) t += ` @${a.entryDistAtr} ATR`;
    parts.push(t);
  } else if (a.blockReason && a.blockReason !== "none") {
    parts.push(a.blockReason);
  }

  if (a.spy !== null) parts.push(`SPY ${a.spy}`);
  parts.push(barHHMM(a.barTime));
  return parts.join(" | ");
}
