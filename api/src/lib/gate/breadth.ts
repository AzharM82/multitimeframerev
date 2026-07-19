// Ported from ShouldIBeTrading (api/src/lib/scoring/breadth.ts).
// Maths preserved exactly; local interpolate() replaced by the shared helper.

import type { BreadthData, CategoryScore } from "./types.js";
import { interpolate } from "./constants.js";

function above200dScore(pct: number): number {
  return interpolate(pct, [
    [15, 10],
    [25, 20],
    [35, 35],
    [45, 50],
    [55, 65],
    [65, 80],
    [75, 95],
    [90, 100],
  ]);
}

function above50dScore(pct: number): number {
  return interpolate(pct, [
    [15, 15],
    [25, 35],
    [40, 55],
    [55, 75],
    [70, 90],
    [85, 100],
  ]);
}

function above20dScore(pct: number): number {
  return interpolate(pct, [
    [10, 15],
    [20, 30],
    [35, 50],
    [50, 70],
    [65, 85],
    [80, 95],
  ]);
}

function adRatioScore(ratio: number): number {
  return interpolate(ratio, [
    [0.3, 10],
    [0.5, 20],
    [0.7, 35],
    [1.0, 50],
    [1.5, 65],
    [2.0, 80],
    [3.0, 95],
    [4.0, 100],
  ]);
}

function nhNlScore(ratio: number): number {
  return interpolate(ratio, [
    [0.1, 10],
    [0.2, 25],
    [0.4, 50],
    [0.6, 75],
    [0.8, 90],
    [0.95, 100],
  ]);
}

export function scoreBreadth(data: BreadthData): CategoryScore & BreadthData {
  const s200 = above200dScore(data.above200d);
  const s50 = above50dScore(data.above50d);
  const s20 = above20dScore(data.above20d);
  const sAD = adRatioScore(data.advDeclineRatio);
  const sNH = nhNlScore(data.nhNlRatio);

  const score = Math.round(s200 * 0.30 + s50 * 0.25 + s20 * 0.20 + sAD * 0.15 + sNH * 0.10);

  let details: string;
  if (score >= 70) details = `Healthy breadth — ${data.above200d}% above 200d MA`;
  else if (score >= 45) details = `Narrowing breadth — ${data.above200d}% above 200d MA`;
  else details = `Weak breadth — only ${data.above200d}% above 200d MA`;

  return {
    score,
    weight: 0.20,
    details,
    ...data,
  };
}
