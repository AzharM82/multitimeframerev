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

// ─── Performance (Section 4) ────────────────────────────────────────────────

export interface PerfStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  bestPct: number;
  worstPct: number;
  bySource: Record<string, { count: number; wins: number; pnl: number }>;
}

export interface ClosedPaperTrade {
  ticker: string;
  source: "bull" | "daytrade" | "avwap";
  entry: number;
  exit: number;
  qty: number;
  pnlDollars: number;
  pnlPct: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
}

export interface OpenPaperTrade {
  ticker: string;
  source: "bull";
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  openedAt: string;
}

export interface DayTradeAlertRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
  status: string;
}

export interface PaperTradesResponse {
  stats: PerfStats;
  open: OpenPaperTrade[];
  closed: ClosedPaperTrade[];
  dayTradeAlerts: { total: number; recent: DayTradeAlertRow[] };
}
