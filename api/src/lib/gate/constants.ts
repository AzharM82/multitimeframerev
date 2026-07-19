// Ported from ShouldIBeTrading (api/src/lib/constants.ts).
// Also hosts the shared numeric helpers that were copy-pasted across
// volatility/breadth/macro (interpolate) and trend/regime (computeSMA) in the
// source. Kept here rather than in a new file so the gate folder stays to the
// agreed file list.

export const SECTOR_ETFS: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLV: "Health Care",
  XLI: "Industrials",
  XLY: "Consumer Disc.",
  XLP: "Consumer Staples",
  XLU: "Utilities",
  XLB: "Materials",
  XLRE: "Real Estate",
  XLC: "Communication",
};

export const SECTOR_TICKERS = Object.keys(SECTOR_ETFS);

export const KEY_TICKERS = ["SPY", "QQQ", "VIX", ...SECTOR_TICKERS];

// Polygon index tickers for macro
export const MACRO_TICKERS = {
  TNX: "I:TNX",   // 10-Year Treasury Yield
  DXY: "I:DXY",   // US Dollar Index
  // Fallbacks if index tickers don't work
  TNX_FALLBACK: "TLT",
  DXY_FALLBACK: "UUP",
};

// Polygon index ticker for VIX
export const VIX_INDEX_TICKER = "I:VIX";

// FOMC meeting conclusion dates for 2025-2026.
// NOTE: hardcoded. Once "today" passes the last entry, computeFomcProximity()
// returns daysUntil = 999 and the FOMC sub-score silently pins to 85, which
// makes the macro score look better than the data supports. Callers should
// check isFomcDataStale() and surface it instead of trusting the default.
export const FOMC_DATES = [
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
  "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-17",
  "2026-01-28", "2026-03-18", "2026-05-06", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-16",
];

/** True once there is no future FOMC date left in FOMC_DATES. */
export function isFomcDataStale(now: Date = new Date()): boolean {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return !FOMC_DATES.some((d) => new Date(d + "T00:00:00").getTime() >= midnight.getTime());
}

/** The last FOMC date we know about — useful for a "data ends on" message. */
export const FOMC_DATA_THROUGH = FOMC_DATES[FOMC_DATES.length - 1];

export const SP500_COUNT = 503; // approximate number of S&P 500 stocks

// ─── Shared numeric helpers ───────────────────────────────────────

/**
 * Piecewise linear interpolation over ascending [x, y] breakpoints.
 * Clamps to the first/last y outside the range.
 * (Deduplicated from volatility.ts / breadth.ts / macro.ts.)
 */
export function interpolate(value: number, breakpoints: [number, number][]): number {
  if (value <= breakpoints[0][0]) return breakpoints[0][1];
  if (value >= breakpoints[breakpoints.length - 1][0]) return breakpoints[breakpoints.length - 1][1];

  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [x0, y0] = breakpoints[i];
    const [x1, y1] = breakpoints[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 50;
}

/** Simple moving average of the last `period` closes; falls back to last close. */
export function computeSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
