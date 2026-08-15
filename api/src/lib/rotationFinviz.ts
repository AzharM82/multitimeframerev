/**
 * Real-time rotation quotes from FinViz Elite.
 *
 * WHY THIS EXISTS: the Polygon plan behind `rotation.ts:fetchQuotes` has no
 * real-time entitlement — its snapshot omits `lastTrade`/`lastQuote` entirely,
 * so every price is the ~15-minute-delayed daily aggregate. The Rotation tab
 * therefore ran on two clocks: the sector/industry tree was Polygon-delayed
 * while the per-stock rows underneath it were already FinViz real-time (see
 * `mm/deskSources.ts`). Same tab, same names, numbers 15 minutes apart.
 * This module puts the whole tab on the FinViz clock.
 *
 * ONE REQUEST, WHOLE MARKET: an export with no `f=` screen and no `t=` list
 * returns every FinViz ticker — ~11.6k rows, ~650 KB, ~0.8s measured — which
 * comfortably covers the 878-name rotation universe. That is dramatically
 * cheaper than batching the universe into `t=` chunks (which would need 5–9
 * requests plus the 2s courtesy gap between each), so the universe is filtered
 * client-side from the one payload instead.
 *
 * COLUMN SET: `v=152` with an explicit `c=` list, the same mechanism (and the
 * same verified-live discipline) as `deskSources.ts`. Header names confirmed
 * against a live export 2026-08-14 — read by NAME here, never by index, so a
 * column-order change at FinViz cannot silently shift a price into a percent.
 */

import { fetchExportFromUrl, isEliteConfigured } from "./mm/finviz.js";
import { getCsvVal, parseNum, parsePct } from "./mm/csv.js";
import type { Quote } from "./rotation.js";

/** Ticker · Change from Open · Price · Change · Volume. */
const COLS = "c=1,60,65,66,67";
const EXPORT_URL = `https://elite.finviz.com/export.ashx?v=152&${COLS}`;

export interface FinvizQuotesResult {
  quotes: Record<string, Quote>;
  /** Universe names FinViz returned a row for. */
  covered: number;
  /** Universe names it did not — see the note on staleness below. */
  missing: string[];
}

/**
 * Live quotes for `tickers`, filtered out of one whole-market export.
 *
 * Returns `null` when FinViz is unconfigured or the export comes back empty, so
 * the caller can fall back to the delayed Polygon path rather than render a
 * blank tab. An empty response is indistinguishable from a dead key here on
 * purpose — both mean "no FinViz data", and both want the same fallback.
 *
 * On the misses: 14 of the 878 universe names return no FinViz row (verified
 * 2026-08-14). They are not a FinViz coverage gap — 13 of the 14 are equally
 * dead at Polygon, i.e. renamed or delisted since the universe CSV was curated
 * (BK now trades as BNY; PSTG and MASI no longer resolve at either vendor). The
 * lone exception is PPLC, a leveraged ETF that Polygon still quotes. They are
 * reported rather than silently dropped, so a growing `missing` list surfaces
 * universe rot instead of quietly shrinking the tree.
 */
export async function fetchQuotesFinviz(tickers: string[]): Promise<FinvizQuotesResult | null> {
  if (!isEliteConfigured()) return null;

  const rows = await fetchExportFromUrl(EXPORT_URL, "rot-quotes");
  if (rows.length === 0) return null;

  const bySymbol = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const symbol = getCsvVal(row, "Ticker").trim().toUpperCase();
    if (symbol) bySymbol.set(symbol, row);
  }

  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];

  for (const ticker of tickers) {
    const row = bySymbol.get(ticker.toUpperCase());
    if (!row) {
      missing.push(ticker);
      continue;
    }

    const price = parseNum(getCsvVal(row, "Price"));
    if (price === null || price <= 0) {
      missing.push(ticker);
      continue;
    }

    // Both arrive as percent strings ("-0.02%"); parsePct yields NaN, not 0, on
    // a blank — so a missing value falls through to 0 explicitly below rather
    // than poisoning the tree's average with NaN.
    const changePercent = parsePct(getCsvVal(row, "Change"));
    const changeFromOpen = parsePct(getCsvVal(row, "Change from Open"));

    // FinViz exports no Open column, but "Change from Open" is defined as
    // (price - open) / open, so the open inverts back out of it:
    //   open = price / (1 + changeFromOpen/100)
    // Checked against Polygon's day.o across all 860 names both feeds quote
    // (2026-08-14): median error 0.00000%, worst 0.053% — RIOT derived 18.81
    // against a true 18.82. The residual is FinViz publishing the percent at
    // 2dp, so precision degrades on low-priced names; it is a rounding floor,
    // not drift, and the tree reads changeFromOpenPercent directly anyway.
    const open = Number.isNaN(changeFromOpen)
      ? 0
      : round2(price / (1 + changeFromOpen / 100));

    quotes[ticker] = {
      price,
      open,
      volume: parseNum(getCsvVal(row, "Volume")) ?? 0,
      changePercent: Number.isNaN(changePercent) ? 0 : changePercent,
      changeFromOpenPercent: Number.isNaN(changeFromOpen) ? 0 : round2(changeFromOpen),
    };
  }

  return { quotes, covered: Object.keys(quotes).length, missing };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
