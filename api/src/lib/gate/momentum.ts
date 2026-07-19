// Ported from ShouldIBeTrading (api/src/lib/scoring/momentum.ts). Maths unchanged.

import type { SectorData, CategoryScore, SnapshotTicker } from "./types.js";
import { SECTOR_ETFS } from "./constants.js";

export function buildSectorData(snapshots: Map<string, SnapshotTicker>): SectorData[] {
  const sectors: SectorData[] = [];

  for (const [ticker, name] of Object.entries(SECTOR_ETFS)) {
    const snap = snapshots.get(ticker);
    if (snap) {
      sectors.push({
        ticker,
        name,
        changePercent: snap.todaysChangePerc ?? 0,
        price: snap.day?.c ?? snap.prevDay?.c ?? 0,
      });
    }
  }

  return sectors.sort((a, b) => b.changePercent - a.changePercent);
}

function pctPositiveScore(sectors: SectorData[]): number {
  if (sectors.length === 0) return 50;
  const positive = sectors.filter((s) => s.changePercent > 0).length;
  return Math.max(5, Math.round((positive / sectors.length) * 100));
}

function topBottomSpreadScore(sectors: SectorData[]): number {
  if (sectors.length < 6) return 50;

  const sorted = [...sectors].sort((a, b) => b.changePercent - a.changePercent);
  const top3Avg = (sorted[0].changePercent + sorted[1].changePercent + sorted[2].changePercent) / 3;
  const bot3Avg = (sorted[sorted.length - 1].changePercent + sorted[sorted.length - 2].changePercent + sorted[sorted.length - 3].changePercent) / 3;

  // If top 3 are negative, cap score
  if (top3Avg < 0) return 20;

  const spread = top3Avg - bot3Avg;

  if (spread > 2.0) return 95;
  if (spread > 1.5) return 80;
  if (spread > 1.0) return 65;
  if (spread > 0.5) return 50;
  if (spread > 0.25) return 40;
  return 30;
}

function avgChangeScore(sectors: SectorData[]): number {
  if (sectors.length === 0) return 50;

  const avg = sectors.reduce((sum, s) => sum + s.changePercent, 0) / sectors.length;

  if (avg > 1.0) return 85;
  if (avg > 0.5) return 70;
  if (avg > 0.0) return 55;
  if (avg > -0.5) return 35;
  return 15;
}

export function scoreMomentum(sectors: SectorData[]): CategoryScore & {
  sectors: SectorData[];
  topBottomSpread: number;
  pctPositive: number;
} {
  const sorted = [...sectors].sort((a, b) => b.changePercent - a.changePercent);

  const top3Avg = sorted.length >= 3
    ? (sorted[0].changePercent + sorted[1].changePercent + sorted[2].changePercent) / 3
    : 0;
  const bot3Avg = sorted.length >= 3
    ? (sorted[sorted.length - 1].changePercent + sorted[sorted.length - 2].changePercent + sorted[sorted.length - 3].changePercent) / 3
    : 0;

  const positiveCount = sectors.filter((s) => s.changePercent > 0).length;
  const pctPositive = sectors.length > 0 ? Math.round((positiveCount / sectors.length) * 100) : 50;

  const s1 = pctPositiveScore(sectors);
  const s2 = topBottomSpreadScore(sectors);
  const s3 = avgChangeScore(sectors);

  const score = Math.round(s1 * 0.4 + s2 * 0.35 + s3 * 0.25);

  let details: string;
  if (score >= 70) details = "Strong sector participation — broad rally underway";
  else if (score >= 45) details = "Selective momentum — leadership is narrow";
  else details = "Weak momentum — most sectors declining";

  return {
    score,
    weight: 0.25,
    details,
    sectors: sorted,
    topBottomSpread: Math.round((top3Avg - bot3Avg) * 100) / 100,
    pctPositive,
  };
}
