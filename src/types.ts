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
  chgOpen: number;
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
  open: number;
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

// ─── Catalyst Value Eval (CVE) ──────────────────────────────────────────────

export type CveRating = "Absolute" | "Yes" | "Maybe" | "No";
export type CveCatalystType = "Fundamental" | "Technical" | "Combination" | "None";
export type CveGrade = "A+" | "A" | "B" | "C" | "D";
export type CveDirection = "positive" | "negative";

export interface CveRatingScore {
  rating: CveRating;
  reason: string;
}

export interface CveResult {
  ticker: string;
  direction: CveDirection;
  changePct: number;
  price: number;
  catalystType: CveCatalystType;
  magnitude: CveRatingScore;
  speed: CveRatingScore;
  grade: CveGrade;
  stopPct: number;
  cve: number;
  commentary: string;
  headline: string;
  newsUrl: string;
  newsAgeHours: number | null;
}

export interface CveScanResponse {
  generated: string;
  asOf: string;
  phase: "open" | "close" | "manual";
  positives: CveResult[];
  negatives: CveResult[];
  tradeable: CveResult[];
  scanned: number;
  discovered: number;
  sources: { finviz: number; polygonMovers: number; news: number };
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

// ─── BIGD-Intraday ───────────────────────────────────────────────────────────

// Per-metric signed contribution: +1 bullish / -1 bearish / 0 neutral.
export interface BigdogParts {
  rev: number;
  atr: number;
  vwap: number;
  vol: number;
  tick: number;
  stoch: number;
}

export interface BigdogAlertHit {
  firedAt: string;
  ticker: string;
  direction: "LONG" | "SHORT";
  listDir: string | null;
  score: number;
  onchartScore: number | null;
  computedScore: number | null;
  scoreMismatch: boolean;
  alertMin: number | null;
  parts: BigdogParts;
  rvDir: string | null;
  rvBars: number | null;
  rvPrice: number | null;
  rvTime: string | null;
  trend: string | null;
  buyPct: number | null;
  tickBal: number | null;
  stochK: number | null;
  stochD: number | null;
  stochSide: string | null;
  vwapSide: string | null;
  atrSide: string | null;
  ocrMisses: string[];
}

export interface BigdogAlertsResponse {
  date: string | null;
  totalHits: number;
  hits: BigdogAlertHit[];
  available?: { date: string; totalHits: number }[];
}

// ─── Unusual Options Activity (UOA scanner → uoa-signals blobs) ─────────────

export interface UoaOiConfirmation {
  tag: "CONFIRMED" | "FADED" | "PARTIAL";
  oi_change: number;
  new_oi: number;
  prior_oi: number;
}

export interface UoaSignal {
  occ_symbol: string;
  underlying: string;
  type: "C" | "P";
  strike: number;
  expiry: string; // ISO date
  dte: number;
  today_volume: number;
  avg_volume_20d: number;
  avg_volume_20d_raw: number;
  vol_ratio: number;
  prior_oi: number | null;      // null in aggs data mode (no OI on plan)
  vol_oi_ratio: number | null;
  last_price: number;
  notional_premium: number;
  anomaly_score: number;
  volume_history: number[];
  oi_confirmation: UoaOiConfirmation | null;
}

export interface UoaAggregate {
  underlying: string;
  side: "C" | "P";
  agg_volume: number;
  agg_avg_20d: number;
  agg_vol_ratio: number;
  put_call_skew: number | null;
}

export interface UoaScanResponse {
  scan_date: string;
  generated_at: string;
  data_delay_note: string;
  data_mode?: "aggs" | "snapshot";
  oi_available?: boolean;
  universe_size: number;
  contracts_scanned: number;
  contracts_fired: number;
  signals: UoaSignal[];
  aggregates: UoaAggregate[];
}

export interface UoaDatesResponse {
  dates: string[];
}

// ─── Rotation (sector/industry rotation — ported from sector-rotation) ──────

export interface RotStockInfo {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
}

export interface RotQuote {
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  vwap: number;
  changePercent: number;          // vs previous close
  changeFromOpenPercent: number;  // vs today's open
}

export interface RotQuotesResponse {
  quotes: Record<string, RotQuote>;
  count: number;
  timestamp: string;              // ISO
  cached: boolean;
  /** Universe + classification; omitted when requested with ?meta=0. */
  stocks?: RotStockInfo[];
}

export interface RotPerformanceResponse {
  performance: Record<string, number>;
  period: "weekly" | "monthly";
  startDate: string;              // ISO date — period's first trading day
  endDate: string;                // ISO date — most recent trading day
  count: number;
  timestamp: string;
  cached: boolean;
}

export interface RotWeek {
  label: string;
  weekIndex: number;              // 0 = current week
  startDate: string | null;
  endDate: string | null;
  /** null when the week could not be resolved — NOT the same as flat. */
  performance: Record<string, number> | null;
}

export interface RotWeeklyHistoryResponse {
  weeks: RotWeek[];
  resolved: number;
  requested: number;
  timestamp: string;
  cached: boolean;
}

// ─── Gate (should-I-be-trading — ported from ShouldIBeTrading) ──────────────

export type GateDecision = "YES" | "CAUTION" | "NO";
export type GateMode = "day" | "swing";

export interface GateCategory {
  score: number;
  weight: number;
  details: string;
}

export interface GatePosture {
  size: string;
  sizePct: number;
  instrument: string;
  direction: string;
  bias: string;
  confidence: string;
  headline: string;
  rationale?: string;
}

export interface GateTickerPrice {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
}

export interface GateScoreResponse {
  decision: GateDecision;
  qualityScore: number;
  executionScore: number;
  mode: GateMode;
  summary: string;
  lastUpdated: string;
  marketOpen: boolean;
  volatility: GateCategory & { vix: { level: number; change: number; trend: string; percentile: number; change5d: number } };
  momentum: GateCategory & { pctPositive: number; topBottomSpread: number };
  trend: GateCategory & { spy: { price: number; ma20: number; ma50: number; ma200: number; rsi14: number; regime: string } };
  breadth: GateCategory & { above20d: number; above50d: number; above200d: number; advDeclineRatio: number };
  macro: GateCategory;
  execution: GateCategory;
  posture: GatePosture;
  tickerPrices: GateTickerPrice[];
  /** Present when a macro feed fell back or failed its sanity guard. */
  dataQuality?: { degraded: boolean; warnings: string[] };
}
