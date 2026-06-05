/**
 * Market breadth / health gauge.
 *
 * Pulls an index's constituents from the Finviz Elite "Technical" export
 * (v=171), which carries each stock's distance (%) from its 20/50/200-day SMA,
 * daily Change, and RSI(14) as columns — so we get true breadth from a SINGLE
 * Finviz call per index, with no Polygon bar-fetching. A stock is "above" an SMA
 * when that distance column is positive.
 *
 * Unlike the ATR Matrix universe (a pre-filtered uptrend screen, so its breadth
 * is biased ~bullish), these are whole indices — a real market-health read.
 */

import { fetchExportFromUrl } from "./finvizElite.js";

// Posture thresholds (tunable). Based on the two trend horizons.
const RISK_ON = { sma50: 55, sma200: 50 };
const RISK_OFF = { sma50: 45, sma200: 45 };

export type Posture = "RISK_ON" | "MIXED" | "RISK_OFF";

export interface BreadthStats {
  label: string;
  filter: string;
  total: number;
  aboveSma20: number;
  aboveSma50: number;
  aboveSma200: number;
  pctAboveSma20: number;
  pctAboveSma50: number;
  pctAboveSma200: number;
  advancers: number;
  decliners: number;
  overbought: number; // RSI > 70
  oversold: number; // RSI < 30
  posture: Posture;
}

/** Parse a Finviz numeric/percent cell ("11.10%", "-1.80%", "66.50") → number. */
function num(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace("%", "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function verdict(pct50: number, pct200: number): Posture {
  if (pct50 >= RISK_ON.sma50 && pct200 >= RISK_ON.sma200) return "RISK_ON";
  if (pct50 < RISK_OFF.sma50 || pct200 < RISK_OFF.sma200) return "RISK_OFF";
  return "MIXED";
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);

/**
 * Compute breadth for one Finviz index filter (e.g. `idx_sp500`, `idx_ndx`).
 * Throws if Finviz returns nothing so the caller can surface the failure.
 */
export async function fetchIndexBreadth(label: string, filter: string): Promise<BreadthStats> {
  const url = `https://elite.finviz.com/export?v=171&f=${filter}`;
  const rows = await fetchExportFromUrl(url, `breadth:${filter}`);
  if (rows.length === 0) throw new Error(`Finviz returned no rows for ${label} (${filter})`);

  let total = 0, a20 = 0, a50 = 0, a200 = 0, adv = 0, dec = 0, ob = 0, os = 0;
  for (const r of rows) {
    const sma20 = num(r["20-Day Simple Moving Average"]);
    const sma50 = num(r["50-Day Simple Moving Average"]);
    const sma200 = num(r["200-Day Simple Moving Average"]);
    const chg = num(r["Change"]);
    const rsi = num(r["Relative Strength Index (14)"]);
    // require at least the 50/200 distances to count a constituent
    if (sma50 === null && sma200 === null) continue;
    total++;
    if (sma20 !== null && sma20 > 0) a20++;
    if (sma50 !== null && sma50 > 0) a50++;
    if (sma200 !== null && sma200 > 0) a200++;
    if (chg !== null) { if (chg > 0) adv++; else if (chg < 0) dec++; }
    if (rsi !== null) { if (rsi > 70) ob++; else if (rsi < 30) os++; }
  }

  const pctAboveSma50 = pct(a50, total);
  const pctAboveSma200 = pct(a200, total);
  return {
    label,
    filter,
    total,
    aboveSma20: a20,
    aboveSma50: a50,
    aboveSma200: a200,
    pctAboveSma20: pct(a20, total),
    pctAboveSma50,
    pctAboveSma200,
    advancers: adv,
    decliners: dec,
    overbought: ob,
    oversold: os,
    posture: verdict(pctAboveSma50, pctAboveSma200),
  };
}
