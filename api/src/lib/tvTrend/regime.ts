import { upsert, getOne, TABLES } from "../tables.js";

/**
 * The regime half of the SPY trend system.
 *
 * The TradingView webhook supplies the TRIGGER (a 5-min breadth streak turning
 * green or red). This supplies the FILTER: the portal's own read on the day,
 * from the Gate — `trend.spy.regime` for direction and `decision` for whether
 * the day is worth trading at all.
 *
 * WHY A STORED SNAPSHOT instead of calling the Gate inline: TradingView cancels
 * a webhook request after 3 seconds, and computeGateScore() does live Polygon
 * and FinViz work. So a timer refreshes this one row and the webhook reads it in
 * a single point lookup. A stale row degrades the recommendation — it never
 * blocks the alert, because a missed signal is worse than an unqualified one.
 */

const PARTITION = "regime";
const ROW = "current";

/** Older than this and we no longer trust it to describe today's market. */
export const REGIME_MAX_AGE_MIN = 90;

export type RegimeDirection = "bullish" | "bearish" | "neutral";
export type GateDecision = "YES" | "CAUTION" | "NO";

export interface RegimeSnapshot {
  /** Raw Gate label, e.g. "Strong Uptrend". */
  label: string;
  direction: RegimeDirection;
  decision: GateDecision;
  qualityScore: number;
  spyPrice: number;
  ma50: number;
  capturedAt: string;
}

/**
 * Gate trend labels → a direction.
 *
 * The Gate emits exactly six labels (lib/gate/trend.ts): Strong Uptrend,
 * Uptrend, Consolidation, Mixed, Downtrend, Strong Downtrend. Anything
 * unrecognised is neutral rather than a guess — a mislabelled direction would
 * recommend the wrong side of the market.
 */
export function classifyRegime(label: string): RegimeDirection {
  const l = String(label || "").toLowerCase();
  if (l.includes("uptrend")) return "bullish";
  if (l.includes("downtrend")) return "bearish";
  return "neutral";
}

export async function writeRegime(snap: RegimeSnapshot): Promise<void> {
  await upsert(TABLES.TV_TREND, PARTITION, ROW, {
    label: snap.label,
    direction: snap.direction,
    decision: snap.decision,
    qualityScore: snap.qualityScore,
    spyPrice: snap.spyPrice,
    ma50: snap.ma50,
    capturedAt: snap.capturedAt,
  });
}

export async function readRegime(): Promise<RegimeSnapshot | null> {
  const row = await getOne<Partial<RegimeSnapshot>>(TABLES.TV_TREND, PARTITION, ROW);
  if (!row?.capturedAt || !row.label) return null;
  return {
    label: row.label,
    direction: (row.direction as RegimeDirection) ?? classifyRegime(row.label),
    decision: (row.decision as GateDecision) ?? "CAUTION",
    qualityScore: row.qualityScore ?? 0,
    spyPrice: row.spyPrice ?? 0,
    ma50: row.ma50 ?? 0,
    capturedAt: row.capturedAt,
  };
}

export function ageMinutes(capturedAt: string, now = Date.now()): number {
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (now - t) / 60_000;
}
