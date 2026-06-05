export type Timeframe = "1W" | "1D" | "65m" | "10m";

export type SignalDirection = "bullish" | "bearish" | "neutral";

export type EmaColor = "green" | "red" | "neutral";

export type VolatilityCategory = "high" | "low";

export interface TimeframeSignal {
  timeframe: Timeframe;
  direction: SignalDirection;
  emaColor: EmaColor;
  reversalPrice: number | null;
  lastBarTime: string | null;
}

export interface StockScan {
  ticker: string;
  price: number;
  atr: number;
  rvol: number;
  volatility: VolatilityCategory;
  industry: string;
  category: string;
  score: number;
  signals: Record<Timeframe, TimeframeSignal>;
  confluence: "bullish" | "bearish" | null;
  lastUpdated: string;
}

export interface WatchlistEntry {
  ticker: string;
  category: string;
}

export interface WatchlistItem {
  ticker: string;
  addedAt: string;
}

export interface Watchlist {
  id: string;
  tickers: WatchlistEntry[];
  updatedAt: string;
}

export interface ScanResponse {
  stocks: StockScan[];
  scannedAt: string;
  marketOpen: boolean;
}

export interface ScanStatus {
  scanning: boolean;
  currentTicker: string | null;
  completedTickers: string[];
  totalTickers: number;
  message: string;
}

export interface NotificationEntry {
  id: string;
  ticker: string;
  type: "bullish" | "bearish";
  timestamp: string;
  message: string;
}

// ─── Phase Oscillator Types ─────────────────────────────────────────────────

export type PhaseZone =
  | "extended_up"
  | "distribution"
  | "neutral_up"
  | "launch_box"
  | "neutral_down"
  | "accumulation"
  | "extended_down";

export type PhaseSignal = "oversold" | "overbought" | null;

export type PhaseLineColor = "green" | "red" | "gray";

export type PhaseTimeframe = "1W" | "1D" | "60m" | "30m";

export interface PhaseTimeframeSignal {
  timeframe: PhaseTimeframe;
  oscillatorValue: number;
  zone: PhaseZone;
  signal: PhaseSignal;
  signalBarsAgo: number;
  compression: boolean;
  lineColor: PhaseLineColor;
}

export interface PhaseStockResult {
  ticker: string;
  price: number;
  score: number;
  signals: Record<PhaseTimeframe, PhaseTimeframeSignal>;
}

export interface PhaseScanResponse {
  stocks: PhaseStockResult[];
  scannedAt: string;
  errors?: Array<{ ticker: string; error: string }>;
}

// ─── Capitulation Scanner Types ─────────────────────────────────────────────

export type CapitulationTier = "CRITICAL" | "HIGH" | "WATCH";

export interface CapitulationSignal {
  ticker: string;
  price: number;
  prevClose: number;
  open: number;
  gapPct: number;
  changePct: number;
  recoveryPct: number;
  rvol: number;
  todayVolume: number;
  prevDayVolume: number;
  tier: CapitulationTier;
  timeWeight: number;
  timeWindow: string;
}

export interface CapitulationScanResponse {
  signals: CapitulationSignal[];
  scannedAt: string;
  marketOpen: boolean;
  totalScanned: number;
  scanDurationMs: number;
}

// ─── Weekly Capitulation Scanner Types ──────────────────────────────────────

export type WeeklyCapTier = "CRITICAL" | "HIGH" | "WATCH";

export interface WeeklyCapSignal {
  ticker: string;
  price: number;
  open: number;
  close5dAgo: number;
  dropPct: number;
  changeFromOpenPct: number;
  rvol: number;
  todayVolume: number;
  prevDayVolume: number;
  tier: WeeklyCapTier;
  capitulating: boolean;
}

export interface WeeklyCapScanResponse {
  signals: WeeklyCapSignal[];
  scannedAt: string;
  marketOpen: boolean;
  totalScanned: number;
  scanDurationMs: number;
}

// ─── Screener Types ─────────────────────────────────────────────────────────

export interface ScreenerRow {
  ticker: string;
  price: string;
  change: string;
  volume: string;
  avg_vol: string;
  rel_vol: string;
  atr_pct: number | null;
  tag?: string;
  roe?: number | null;
  net_margin?: number | null;
  news?: string;
  news_url?: string;
}

// ─── AVWAP (Section 1) ──────────────────────────────────────────────────────

export type AvwapPattern = "PULLBACK" | "PINCH" | "RECLAIM";
export type AnchorKind = "ATH" | "52W_HIGH" | "52W_LOW" | "YTD" | "SWING_LOW";

export interface AvwapHit {
  ticker: string;
  pattern: AvwapPattern;
  price: number;
  buy?: number;
  sl?: number;
  slPct?: number;
  score: number;
  involvedAnchors: AnchorKind[];
  bandPct: number;
  volumeMultiple: number;
  trendAligned: boolean;
  daysSinceTrigger: number;
  asOf: string;
  details: {
    avwapValues: Record<AnchorKind, number | null>;
    sma50: number | null;
    sma200: number | null;
    rsi14: number | null;
  };
}

export interface AvwapResultsResponse {
  date: string | null;
  totalHits: number;
  updatedAt?: string;
  hits: AvwapHit[];
  available?: { date: string; totalHits: number }[];
}

// ─── Bull List (Section 2) ──────────────────────────────────────────────────

export type BullStatus = "OPEN" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export interface BullListRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  entry: number;
  sl: number;
  tp: number;
  rPct: number;
  status: BullStatus;
  addedAt: string;
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  source: string;
  emailSubject: string;
  reversalBarTs: string;
  last?: number | null;
  pnlPct?: number | null;
}

export interface BullListResponse {
  status: "open" | "closed";
  count: number;
  rows: BullListRow[];
}

// ─── Day Trade Alerts (Section 3) ───────────────────────────────────────────

export interface DayTradeAlertRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
  status: string;
  // SL = min low over the last 3 10m bars ending at the U1 bar. Optional for
  // backwards compat with historic rows (pre-SL feature). slPct is negative.
  sl?: number;
  slPct?: number;
  // Live-enriched at GET time by paperTrades.ts (Polygon snapshot).
  // Undefined if snapshot fetch failed or quote unavailable.
  currentPrice?: number;
}

export interface DayTradeAlertsResponse {
  total: number;
  recent: DayTradeAlertRow[];
}

// ─── ATR Matrix (Section: swing extension scanner) ──────────────────────────

export type AtrZone = "LEAVE" | "ENTRY" | "HOLD" | "EXTENDED" | "BLOWOFF";
export type AtrAction = "sell" | "reduce" | "inflection" | "restore" | "buy" | "hold";

export interface AtrStock {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number;
  close: number;
  chg: number;
  atr: number;
  atrPct: number;
  ext: number;
  extPrev: number;
  bucket: number;
  zone: AtrZone;
  sma50: number;
  sma20: number;
  sma200: number;
  structure: number;
  ema10: number;
  ema10Prev: number;
  sma20Prev: number;
  prevClose: number;
  dvol: number;
  r1w: number;
  r1m: number;
  r3m: number;
  r6m: number;
  aboveSMA50: boolean;
  stopSuggest: number;
  ladder: Record<number, number>;
  rvol?: number;
  volWeek?: number;
  avgVol?: number;
  atrRS: number;
  rs: number;
  grade: string;
  action: AtrAction;
}

export interface AtrLookupResponse {
  stock: AtrStock;
  inUniverse: boolean;
}

export interface IntradayQuote {
  price: number;
  prevClose: number;
  prevHigh: number;
  dayHigh: number;
  dayLow: number;
  changePerc: number;
}

export interface AtrIntradayResponse {
  asOf: string;
  quotes: Record<string, IntradayQuote>;
}

export interface AtrScanResponse {
  generated: string;
  asOf: string;
  count: number;
  avgAtrPct: number;
  pctAboveSMA50: number;
  buyable: number;
  extended7: number;
  stocks: AtrStock[];
}

// Client-side (localStorage) position tracking for the ATR Matrix tab.
export interface AtrPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stop: number;
}

// ─── Market Breadth / Health gauge ──────────────────────────────────────────

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
  overbought: number;
  oversold: number;
  posture: Posture;
}

export interface BreadthResponse {
  generated: string;
  indices: BreadthStats[];
}
