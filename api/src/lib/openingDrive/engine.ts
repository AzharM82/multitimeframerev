/**
 * Opening Drive — Phase-2 engine (cloud, Alpaca IEX).
 *
 * Pure over its inputs: given a candidate's stored levels, today's IEX 2-min
 * bars, and a same-slot RVOL baseline, it produces the current state transition
 * (gate/trigger/stuffed/exit). The Azure function feeds it live bars every 2
 * minutes and records/alerts the transitions. All decisions run through the
 * shared, tested `trigger.ts` — the same code the historical replay validates.
 *
 * Everything stays in IEX space: PMH is the IEX pre-market high, RVOL is IEX
 * bar volume over an IEX same-slot baseline, so the partial-volume feed is
 * internally consistent and the live close is compared to an IEX-derived level.
 */

import {
  type Bar,
  evaluateGate,
  evaluateTrigger,
  etMinutes,
  type GateMode,
} from "./trigger.js";
import type { OpeningDriveConfig } from "./config.js";

export interface CandidateState {
  ticker: string;
  priorClose: number;
  ydayHigh: number;
  catalystType?: string;
  catalystStrength?: string;
  catalystHeadline?: string | null;
  sectorEtfPct?: number | null;
  /** Prior recorded state on the row, so we only emit transitions. */
  state?: string | null;
  entry?: number | null;
  stop?: number | null;
  pmHighUsed?: number | null;
}

export type EngineStateOut =
  | { kind: "none" }
  | { kind: "GATE_FAIL"; reason: string }
  | { kind: "GATE_PASS"; clearedYdayHigh: boolean }
  | { kind: "STUFFED"; barTimeEt: string }
  | {
      kind: "TRIGGERED";
      entry: number;
      stop: number;
      pmHigh: number;
      rvol: number;
      riskPerShare: number;
      suggestedShares: number;
      barTimeEt: string;
    }
  | { kind: "EXIT"; reason: string; barTimeEt: string };

const RTH_OPEN = 570; // 9:30 in ET minutes
const PM_START = 240; // 04:00

/** IEX pre-market high (04:00–09:30) for the day, from IEX bars. */
export function premarketHigh(bars: Bar[]): number {
  let hi = 0;
  for (const b of bars) {
    const m = etMinutes(b.timestamp);
    if (m >= PM_START && m < RTH_OPEN) hi = Math.max(hi, b.high);
  }
  return hi;
}

/**
 * Same-slot RVOL baseline: average volume per 2-min ET slot over prior days.
 * `priorDayBars` are IEX 2-min bars from the prior N trading days (RTH). Returns
 * a map slotMinutes → average volume across the distinct prior days seen.
 */
export function buildSlotBaseline(priorDayBars: Bar[]): Record<number, number> {
  // slot -> (date -> summed volume for that slot on that date)
  const bySlot = new Map<number, Map<string, number>>();
  for (const b of priorDayBars) {
    const m = etMinutes(b.timestamp);
    if (m < RTH_OPEN || m >= 960) continue; // RTH only
    const day = new Date(b.timestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (!bySlot.has(m)) bySlot.set(m, new Map());
    const dm = bySlot.get(m)!;
    dm.set(day, (dm.get(day) ?? 0) + b.volume);
  }
  const out: Record<number, number> = {};
  for (const [slot, dm] of bySlot) {
    const vols = [...dm.values()];
    out[slot] = vols.length ? vols.reduce((a, c) => a + c, 0) / vols.length : 0;
  }
  return out;
}

/** RTH 2-min bars for today, in order, up to and including the last completed one. */
function todaysRthBars(bars: Bar[], nowMs: number): Bar[] {
  const nowMin = etMinutes(nowMs);
  return bars
    .filter((b) => {
      const m = etMinutes(b.timestamp);
      // A 2-min bar opening at m is "completed" once the clock passes m+2.
      return m >= RTH_OPEN && m + 2 <= nowMin;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

function etClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Evaluate one candidate against today's bars. Emits only NEW transitions
 * relative to `cand.state` so the caller alerts once per event.
 */
export function evaluateCandidate(
  cand: CandidateState,
  todayBars: Bar[],
  baseline: Record<number, number>,
  cfg: OpeningDriveConfig,
  nowMs: number,
): EngineStateOut {
  const pmHigh = premarketHigh(todayBars);
  const rth = todaysRthBars(todayBars, nowMs);
  if (!rth.length || pmHigh <= 0) return { kind: "none" };

  const openPrice = rth[0].open;
  const gate = evaluateGate(openPrice, cand.ydayHigh, cand.priorClose, cfg.gateMode as GateMode);

  const alreadyGateFailed = cand.state === "GATE_FAIL";
  const alreadyTriggered = cand.state === "TRIGGERED" || cand.state === "EXIT";

  if (!gate.pass) {
    return alreadyGateFailed ? { kind: "none" } : { kind: "GATE_FAIL", reason: gate.reason };
  }

  // Post-trigger monitor: once triggered, watch subsequent bars for an exit.
  if (alreadyTriggered && cand.state === "TRIGGERED" && cand.stop != null && cand.pmHighUsed != null) {
    const last = rth[rth.length - 1];
    if (last.low < cand.stop) {
      return { kind: "EXIT", reason: "STOPPED (took out breakout candle low)", barTimeEt: etClock(last.timestamp) };
    }
    if (last.close < cand.pmHighUsed) {
      return { kind: "EXIT", reason: "FAILURE (closed back below PMH)", barTimeEt: etClock(last.timestamp) };
    }
    return { kind: "none" };
  }
  if (alreadyTriggered) return { kind: "none" };

  // Trigger scan: fire on the first qualifying completed bar; report a stuff
  // otherwise. RVOL uses the same-slot baseline for that bar's ET minute.
  let stuffedBarEt: string | null = null;
  for (const bar of rth) {
    const slot = etMinutes(bar.timestamp);
    const base = baseline[slot] ?? 0;
    const rvol = base > 0 ? bar.volume / base : 0;
    const chk = evaluateTrigger(bar, pmHigh, rvol, cfg);
    if (chk.fired) {
      const risk = bar.close - bar.low;
      return {
        kind: "TRIGGERED",
        entry: bar.close,
        stop: bar.low,
        pmHigh,
        rvol,
        riskPerShare: risk,
        suggestedShares: risk > 0 ? Math.floor(cfg.accountRiskDollars / risk) : 0,
        barTimeEt: etClock(bar.timestamp),
      };
    }
    if (chk.stuffed) stuffedBarEt = etClock(bar.timestamp);
  }

  if (stuffedBarEt && cand.state !== "STUFFED") return { kind: "STUFFED", barTimeEt: stuffedBarEt };
  if (gate.pass && cand.state !== "GATE_PASS" && cand.state !== "STUFFED") {
    return { kind: "GATE_PASS", clearedYdayHigh: gate.clearedYdayHigh };
  }
  return { kind: "none" };
}
