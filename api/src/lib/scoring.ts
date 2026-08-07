/**
 * Sector Desk scoring — a pure, network-free port of the sector-options-desk
 * spec's math, with every options term removed.
 *
 * The board answers one question: which sector group is running today, and
 * which liquid stocks inside it are running with it. Direction is expressed as
 * LONG / SHORT (the operator picks their own options off that) — never as an
 * options product. No flow/greeks/IV inputs exist here.
 *
 * All thresholds live in `TUNING` so the desk can be re-tuned in one place.
 * Percentile ranking is delegated to `stats.percentileRank` (do not reimplement
 * — it carries the golden-vector tie semantics).
 */

import { percentileRank } from "./stats.js";

export type Direction = "LONG" | "SHORT";

export const TUNING = {
  /** Group gates — a group must clear all three to be tradeable. */
  minGroupMove: 0.55, // % — ETF absolute day change
  /**
   * Volume conviction is measured from the MEMBERS, not the ETF wrapper — an ETF
   * can trade light while its constituents run hot (Energy, 2026-08-06: XLE was
   * 0.76× but OXY/KNTK/HP were 1.6–2.1×). A member "participates" when its
   * rel-volume ≥ `volParticipationFloor`; the group passes when the share of
   * participating members ≥ `minVolParticipation`. Relaxed vs the old 1.05× bar.
   */
  volParticipationFloor: 1.0, // × — a member counts as participating at/above its own avg volume
  minVolParticipation: 0.4, // fraction of members that must participate (relaxed)
  minBreadth: 0.6, // fraction of members agreeing with the ETF's direction

  /** Group-strength weights (spec's flow weight 0.15 dropped, renormalized). */
  groupWeights: { move: 0.47, rvol: 0.23, breadth: 0.3 },
  moveSaturation: 2.5, // % — move term maxes out here

  /** Regime router: min best−worst sector spread (pts) to call a rotation. */
  dispersionPts: 1.2,

  /** In-group stock ranking. */
  rankWeights: { dollarVol: 0.4, relVol: 0.25, alignedMove: 0.35 },
  againstGroupMult: 0.45, // score multiplier when a stock moves against its group
  thinDollarVol: 25_000_000, // $ — below this a name is flagged THIN $VOL

  topStocks: 12, // cap on ranked names returned per group
} as const;

// ---------------------------------------------------------------------------
// Group strength
// ---------------------------------------------------------------------------

export interface GroupGateInput {
  /** ETF day change %, signed — the direction anchor. */
  chg: number;
  /** Share of members trading ≥ their own average volume, 0..1. */
  volPart: number;
  /** Share of members whose day_chg sign agrees with the ETF, 0..1. */
  breadth: number;
}

export interface GroupScore {
  /** Signed strength ±100 (sign = direction, magnitude = conviction). */
  gss: number;
  /** Unsigned conviction 0..100. */
  conviction: number;
  /** Trade direction if the group clears its gates, else null. */
  bias: Direction | null;
  tradeable: boolean;
  /** Human-readable reasons the group failed its gates (empty when tradeable). */
  blockers: string[];
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function groupStrength(g: GroupGateInput): GroupScore {
  const absMove = Math.abs(g.chg);
  const blockers: string[] = [];
  if (absMove < TUNING.minGroupMove) {
    blockers.push(`move ${absMove.toFixed(2)}% < ${TUNING.minGroupMove}%`);
  }
  if (g.volPart < TUNING.minVolParticipation) {
    blockers.push(`vol ${Math.floor(g.volPart * 100)}% < ${Math.round(TUNING.minVolParticipation * 100)}%`);
  }
  if (g.breadth < TUNING.minBreadth) {
    blockers.push(`breadth ${Math.floor(g.breadth * 100)}% < ${Math.round(TUNING.minBreadth * 100)}%`);
  }

  const w = TUNING.groupWeights;
  const moveTerm = Math.min(absMove, TUNING.moveSaturation) / TUNING.moveSaturation;
  const rvolTerm = clamp01(g.volPart); // participation is already 0..1
  const breadthTerm = clamp01(g.breadth);
  const conviction = Math.round(
    100 * (w.move * moveTerm + w.rvol * rvolTerm + w.breadth * breadthTerm),
  );

  const dir = g.chg >= 0 ? 1 : -1;
  const tradeable = blockers.length === 0;
  return {
    gss: dir * conviction,
    conviction,
    bias: tradeable ? (dir > 0 ? "LONG" : "SHORT") : null,
    tradeable,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Regime router
// ---------------------------------------------------------------------------

export type RegimeState = "ROTATION" | "ONE_SIDED" | "COMPRESSED" | "UNCONFIRMED";
export type Vehicle = "SECTOR" | "INDEX";

export interface RegimeGroupLite {
  sector: string; // display label
  chg: number; // ETF day change %
  tradeable: boolean;
  bias: Direction | null;
}

export interface RegimeTarget {
  sector: string;
  side: Direction;
}

export interface Regime {
  state: RegimeState;
  vehicle: Vehicle;
  headline: string;
  detail: string;
  dispersion: number; // best% − worst%
  targets: RegimeTarget[];
}

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

export function routeRegime(groups: RegimeGroupLite[]): Regime {
  if (groups.length === 0) {
    return {
      state: "UNCONFIRMED",
      vehicle: "INDEX",
      headline: "No sector data",
      detail: "No group readings available — nothing to route.",
      dispersion: 0,
      targets: [],
    };
  }

  const sorted = [...groups].sort((a, b) => b.chg - a.chg);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const dispersion = best.chg - worst.chg;
  const wide = dispersion >= TUNING.dispersionPts;

  // A leg only counts if the group clears its gates AND points the expected way.
  const leaderPass = best.tradeable && best.bias === "LONG";
  const laggardPass = worst.tradeable && worst.bias === "SHORT";

  if (!wide) {
    return {
      state: "COMPRESSED",
      vehicle: "INDEX",
      headline: "Compressed — trade the index",
      detail: `Sector spread is only ${dispersion.toFixed(2)}pt (< ${TUNING.dispersionPts}pt). No rotation edge; use a broad index vehicle.`,
      dispersion,
      targets: [],
    };
  }

  if (leaderPass && laggardPass) {
    return {
      state: "ROTATION",
      vehicle: "SECTOR",
      headline: `Rotation: ${best.sector} ↑ vs ${worst.sector} ↓`,
      detail: `${dispersion.toFixed(2)}pt spread — long ${best.sector} (${pct(best.chg)}), short ${worst.sector} (${pct(worst.chg)}).`,
      dispersion,
      targets: [
        { sector: best.sector, side: "LONG" },
        { sector: worst.sector, side: "SHORT" },
      ],
    };
  }

  if (leaderPass || laggardPass) {
    const t: RegimeTarget = leaderPass
      ? { sector: best.sector, side: "LONG" }
      : { sector: worst.sector, side: "SHORT" };
    const g = leaderPass ? best : worst;
    return {
      state: "ONE_SIDED",
      vehicle: "SECTOR",
      headline: `One-sided: ${t.side === "LONG" ? "long" : "short"} ${t.sector}`,
      detail: `Only ${t.sector} clears the gate (${pct(g.chg)}). The other end didn't confirm on volume/breadth.`,
      dispersion,
      targets: [t],
    };
  }

  return {
    state: "UNCONFIRMED",
    vehicle: "INDEX",
    headline: "Unconfirmed — trade the index",
    detail: `Spread is ${dispersion.toFixed(2)}pt but neither end clears volume/breadth. No group has conviction; use a broad index vehicle.`,
    dispersion,
    targets: [],
  };
}

// ---------------------------------------------------------------------------
// In-group stock ranking
// ---------------------------------------------------------------------------

export interface StockRankInput {
  ticker: string;
  company?: string;
  chg: number; // day change %
  relVol: number; // relative volume ×
  dollarVol: number; // close × volume, $
}

export interface RankedStock {
  ticker: string;
  company?: string;
  chg: number;
  relVol: number;
  dollarVol: number;
  aligned: number; // chg × groupDir — positive means moving with the group
  score: number; // 0..100
  side: Direction;
  flags: string[]; // "THIN $VOL", "AGAINST GROUP"
}

/**
 * Rank a group's members by how hard they're running WITH the group, weighted by
 * $-liquidity and relative volume. `groupDir` is +1 for a LONG group, −1 for a
 * SHORT group; a stock moving against that direction is penalized and flagged.
 */
export function rankStocks(rows: StockRankInput[], groupDir: 1 | -1): RankedStock[] {
  if (rows.length === 0) return [];

  const dvPct = percentileRank(rows.map((r) => r.dollarVol));
  const rvPct = percentileRank(rows.map((r) => r.relVol));
  const aligned = rows.map((r) => r.chg * groupDir);
  const amPct = percentileRank(aligned);
  const w = TUNING.rankWeights;

  const ranked: RankedStock[] = rows.map((r, i) => {
    let score = 100 * (w.dollarVol * dvPct[i] + w.relVol * rvPct[i] + w.alignedMove * amPct[i]);
    const against = aligned[i] < 0;
    if (against) score *= TUNING.againstGroupMult;

    const flags: string[] = [];
    if (r.dollarVol < TUNING.thinDollarVol) flags.push("THIN $VOL");
    if (against) flags.push("AGAINST GROUP");

    return {
      ticker: r.ticker,
      company: r.company,
      chg: r.chg,
      relVol: r.relVol,
      dollarVol: r.dollarVol,
      aligned: aligned[i],
      score: Math.round(score),
      side: groupDir > 0 ? "LONG" : "SHORT",
      flags,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, TUNING.topStocks);
}
