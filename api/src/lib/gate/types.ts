// Ported from ShouldIBeTrading (api/src/lib/types.ts).
// Self-contained gate types. Trade-log types intentionally NOT ported
// (tradeLog.ts / calibration.ts are out of scope for this pass).

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: number; // timestamp ms
}

export interface SnapshotTicker {
  ticker: string;
  todaysChange: number;
  todaysChangePerc: number;
  day: { o: number; h: number; l: number; c: number; v: number };
  prevDay: { o: number; h: number; l: number; c: number; v: number };
  lastTrade?: { p: number };
  min?: { c: number };
}

export interface SectorData {
  ticker: string;
  name: string;
  changePercent: number;
  price: number;
}

export interface VixData {
  level: number;
  change: number;
  trend: "rising" | "falling" | "flat";
  percentile: number;
  change5d: number;
}

export interface TrendData {
  spy: {
    price: number;
    ma20: number;
    ma50: number;
    ma200: number;
    rsi14: number;
    regime: string;
  };
  qqq: {
    price: number;
    ma50: number;
  };
}

export interface BreadthData {
  above20d: number;
  above50d: number;
  above200d: number;
  advDeclineRatio: number;
  newHighs: number;
  newLows: number;
  nhNlRatio: number;
}

export interface MacroData {
  tnx: { price: number; change5d: number; trend: "rising" | "falling" | "flat" };
  dxy: { price: number; change5d: number; trend: "rising" | "falling" | "flat" };
  fomcProximity: {
    daysUntil: number;
    nextDate: string;
    isToday: boolean;
    /** True when FOMC_DATES ran out — the macro sub-score is a default, not data. */
    stale?: boolean;
    dataThrough?: string;
  };
}

export interface ExecutionData {
  breakoutsHolding: number;
  pullbacksBought: number;
  followThrough: number;
}

export interface CategoryScore {
  score: number;
  weight: number;
  details: string;
}

export interface TradePosture {
  size: "FULL" | "HALF" | "QUARTER" | "NONE";
  sizePct: number; // 0 | 25 | 50 | 100
  instrument: "OPTIONS" | "STOCK" | "SPREADS" | "CASH";
  direction: "CALLS" | "PUTS" | "NEITHER";
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  headline: string;
  rationale: string;
}

export type TradingMode = "swing" | "day";

/**
 * Data-quality flags surfaced to the caller. The original ShouldIBeTrading
 * failed soft to 0 on quote errors, which produced a spuriously BULLISH
 * "VIX = 0" reading. Anything degraded should be shown, not swallowed.
 */
export interface DataQuality {
  degraded: boolean;
  warnings: string[];
}

export interface MarketScoreResponse {
  decision: "YES" | "CAUTION" | "NO";
  qualityScore: number;
  executionScore: number;
  mode: TradingMode;
  summary: string;
  lastUpdated: string;
  marketOpen: boolean;

  volatility: CategoryScore & { vix: VixData };
  momentum: CategoryScore & { sectors: SectorData[]; topBottomSpread: number; pctPositive: number };
  trend: CategoryScore & TrendData;
  breadth: CategoryScore & BreadthData;
  macro: CategoryScore & MacroData;
  execution: CategoryScore & ExecutionData;

  posture: TradePosture;

  tickerPrices: Array<{ ticker: string; price: number; change: number; changePercent: number }>;

  dataQuality?: DataQuality;
}
