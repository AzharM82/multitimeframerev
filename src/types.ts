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

// ─── Metrics (MarketMetrics core panels) ────────────────────────────────────

export type MmPanelName =
  | "key-metrics"
  | "breadth"
  | "screeners"
  | "movers"
  | "sector-desk"
  | "index-leaders"
  | "rotation-stocks";

export interface MmPanelResponse<T = unknown> {
  panel: MmPanelName;
  generated: string;  // ISO
  data: T;
}

export interface MmKeyMetricRow {
  label: string;
  above: number;
  below: number;
  pct: number;
}

export interface MmKeyMetricsData {
  groups: Record<string, { group: string; rows: MmKeyMetricRow[] }>;
  labels: string[];
}

export interface MmBreadthRow {
  date: string;
  up4: number;
  down4: number;
  ratio5: number;
  ratio10: number;
  t2108: number;
  sp500: number;
}

export interface MmBreadthData {
  latest: MmBreadthRow | null;
  history: MmBreadthRow[];
}

export interface MmScreenerRow {
  ticker: string;
  price?: string | number;
  change?: string;
  volume?: string | number;
  rel_vol?: string | number;
  atr_pct?: number | null;
  tag?: string;
  [k: string]: unknown;
}

export interface MmScreenersData {
  qullamaggie: MmScreenerRow[];
  minervini: MmScreenerRow[];
  oneil: MmScreenerRow[];
}

export interface MmMoversData {
  club97: MmScreenerRow[];
  m9m: MmScreenerRow[];
  w20pct: MmScreenerRow[];
  d4pct: MmScreenerRow[];
}

// ─── Sector Desk + Index Leaders ────────────────────────────────────────────
// Stock-only rotation board. Direction is LONG/SHORT — the operator picks their
// own options off it, so NO options fields exist in these payloads.

export type DeskDirection = "LONG" | "SHORT";
export type DeskRegimeState = "ROTATION" | "ONE_SIDED" | "COMPRESSED" | "UNCONFIRMED";
export type DeskVehicle = "SECTOR" | "INDEX";

export interface DeskRankedStock {
  ticker: string;
  company?: string;
  chg: number;
  relVol: number;
  dollarVol: number;
  aligned: number;
  score: number;
  side: DeskDirection;
  flags: string[];
  close: number;
  /** % change from the open. */
  changeFromOpen: number | null;
  /** Signed % distance of price from each MA (positive = price above the MA). */
  distEma10: number | null;
  distEma20: number | null;
  distSma50: number | null;
  distSma200: number | null;
  /** 65-bar 30-min SMA — the "5-day" line. */
  dist5day: number | null;
}

export interface DeskGroup {
  key: string;
  sector: string;
  etf: string;
  etfMove: number;
  etfFromOpen: number;
  etfRvol: number;
  volParticipation: number;
  breadth: number;
  memberCount: number;
  gss: number;
  conviction: number;
  bias: DeskDirection | null;
  tradeable: boolean;
  blockers: string[];
  stocks: DeskRankedStock[];
}

export interface DeskRegime {
  state: DeskRegimeState;
  vehicle: DeskVehicle;
  headline: string;
  detail: string;
  dispersion: number;
  targets: { sector: string; side: DeskDirection }[];
}

export interface MmSectorDeskData {
  generatedEt: string;
  sessionNote: string;
  regime: DeskRegime;
  groups: DeskGroup[];
}

/**
 * Rotation per-stock price context, keyed by ticker (`rotation-stocks` panel).
 *
 * Same columns the Sector Desk shows, minus the 5-day line — that one needs
 * Alpaca 30-min bars, which don't scale to Rotation's ~880-name universe inside
 * a function timeout. Sourced from FinViz's real-time tier, unlike Rotation's
 * sector/industry aggregates which come from Polygon ~15 min delayed.
 */
export interface RotationStockRow {
  close: number;
  chg: number;
  changeFromOpen: number | null;
  relVol: number | null;
  dollarVol: number;
  distSma50: number | null;
  distSma200: number | null;
  distEma10: number | null;
  distEma20: number | null;
}

export type RotationEnrichMap = Record<string, RotationStockRow>;

// ─── Trade Journal ───────────────────────────────────────────────────────────
// Robinhood fills pushed up by tools/journal-sync on the dev machine. Only
// closing fills carry `realizedPnl`; opens are legitimately null.

export interface JournalFill {
  id: string;
  tradeDate: string; // YYYY-MM-DD ET
  ticker: string; // OCC-style for options: "AAPL  260807C00315000"
  underlying: string;
  assetType: string; // OPTION | EQUITY
  side: string; // BUY | SELL
  quantity: number;
  price: number;
  fees: number;
  realizedPnl: number | null;
  /**
   * Of a closing fill, how many contracts came from a lot opened on an EARLIER
   * day (0 on buys, and on same-day round trips). Realized P&L is dated by the
   * close, so without this an overnight loss reads as the exit day's mistake.
   */
  carriedQty: number;
  /** Earliest day those carried contracts were opened, else null. */
  openedOn: string | null;
  /**
   * Qty of this (day, symbol) group still open at that day's close. The same
   * value on every fill of the group — the sync computes it from full history,
   * which the page does not have (it only sees fills from the epoch forward).
   */
  groupOpenQty: number;
  filledAt: string;
  broker: string;
}

export interface JournalTradesResponse {
  from: string;
  to: string;
  epoch: string;
  count: number;
  fills: JournalFill[];
}

export interface JournalNote {
  date: string;
  underlying: string;
  text: string;
  updatedAt: string;
}

export interface JournalNotesResponse {
  from: string;
  to: string;
  count: number;
  notes: JournalNote[];
}

export interface JournalSummaryResponse {
  points: string[]; // at most 10, ever
  noteCount: number;
  generatedAt: string | null;
  versions: number;
}

export interface SectorHistPoint {
  date: string; // YYYY-MM-DD
  gss: number; // signed strength −100..+100
  fromOpen: number;
  tradeable: boolean;
  bias: string; // "LONG" | "SHORT" | ""
}

export interface SectorHistorySeries {
  key: string;
  sector: string;
  etf: string;
  points: SectorHistPoint[]; // ascending by date
}

export interface SectorDeskHistoryResponse {
  days: number;
  sectors: SectorHistorySeries[];
}

export interface IndexLeader {
  ticker: string;
  chg: number;
  volume: number;
  relVol: number;
  close: number;
  dollarVol: number;
}

export interface IndexBlock {
  key: string;
  label: string;
  memberCount: number;
  leaders: IndexLeader[];
}

export interface MmIndexLeadersData {
  generatedEt: string;
  indices: IndexBlock[];
}

// ─── TradingView chart analysis (desktop sidecar) ───────────────────────────

/** One piece of weighted evidence. Weight encodes authority, not agreement. */
export interface TvSignalRow {
  weight: number;
  signal: string;
  detail: string;
}

export interface TvAnalysisResponse {
  symbol: string;
  resolution?: string;
  price: number | null;
  verdict: string;
  dailyBias: "bull" | "bear" | null;
  bullScore: number;
  bearScore: number;
  net: number;
  gateFailures: string[];
  bullish: TvSignalRow[];
  bearish: TvSignalRow[];
  /** Present when the sidecar failed rather than produced a reading. */
  error?: string;
  computedAt: string;
  requestId?: string;
  /** Seconds since the sidecar computed this — drives the staleness badge. */
  ageSeconds: number;
  meta?: {
    chartId?: string;
    studiesPopulated?: number;
    totalStudies?: number;
    launchState?: string;
  };
}

export interface TvRequestResponse {
  status: string;
  ticker: string;
  requestId: string;
  requestedAt: string;
}

/** One 10-minute bar's net score, for the intraday trend histogram. */
export interface TvHistoryPoint {
  at: string;
  bucket: number;
  net: number;
  bullScore: number;
  bearScore: number;
  verdict: string;
  price: number | null;
}

export interface TvHistoryResponse {
  ticker: string;
  date: string;
  count: number;
  points: TvHistoryPoint[];
}

// ─── Opening Drive (SMB pre-market-high break) ──────────────────────────────

export interface OpeningDriveCandidate {
  ticker: string;
  gapPct: number;
  pmHigh: number;
  pmVolume: number;
  pmLast: number;
  ydayHigh: number;
  priorClose: number;
  atrPct: number;
  roomOverheadPct: number | null;
  ath: boolean;
  sector: string;
  sectorEtf: string | null;
  sectorEtfPct: number | null;
  marketCap: number | null;
  catalystType: "NEWS" | "ATH" | "BASE" | "NONE";
  catalystStrength: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  catalystHeadline: string | null;
  catalystSource: string | null;
  catalystTimeEt: string | null;
  sectorSympathy: boolean;
  demoted: boolean;
  // Live state stamped by the Phase-2 engine (absent until the open).
  state?: "GATE_PASS" | "GATE_FAIL" | "TRIGGERED" | "STUFFED" | "EXIT";
  stateAt?: string;
  entry?: number | null;
  stop?: number | null;
  riskPerShare?: number | null;
  suggestedShares?: number | null;
  rvol?: number | null;
  triggerBarEt?: string | null;
  exitReason?: string | null;
}

export interface OpeningDriveResponse {
  date: string;
  regime: "GREEN" | "YELLOW" | "RED" | null;
  spyPct: number | null;
  discovered: number;
  asOf: string | null;
  count: number;
  candidates: OpeningDriveCandidate[];
}

// ── SPY Conviction Score ─────────────────────────────────────────────────────
// TradingView's six-leg 10-minute indicator (Cum TICK, volume pressure, SPY vs
// VWAP, SPY vs EMA9, SPY/RSP lead, VIX) emits the decision directly. Replaced
// the 5-min breadth-streak + Gate-regime system on 2026-08-12.
//
// Every field is a record of a DECISION, including the ones that deliberately
// produced no alert — silence is the state the operator most needs to see.

export type ConvictionSignal =
  | "ARM_CALL" | "ARM_PUT" | "ARM_CANCEL"
  | "BUY_CALL" | "BUY_PUT"
  | "HOLD_CALL" | "HOLD_PUT"
  | "REDUCE_CALL" | "REDUCE_PUT"
  | "SELL_CALL" | "SELL_PUT"
  | "STAND_ASIDE";

export type ConvictionState = "FLAT" | "ARMED_CALL" | "ARMED_PUT" | "LONG_CALL" | "LONG_PUT";

export interface ConvictionEvent {
  receivedAt: string;
  strategy: string;
  signal: ConvictionSignal;
  action: string;
  side: "CALL" | "PUT" | "NONE";

  grade: string;
  bias: string;
  score: number;
  legsAgree: number;

  entryTrigger: string;
  entryDistAtr: number;
  extAtr: number;
  barsHeld: number;
  entryScore: number;
  entryPx: number;
  blockReason: string;

  /** The six legs, plus price context. */
  spy: number;
  vwap: number;
  ema9: number;
  atr: number;
  vix: number;
  tick: number;
  cvd: number;
  breadthRatio: number;

  tf: string;
  chartSymbol: string;
  /** The indicator's bar timestamp, and the HH:MM the alert line prints. */
  barTime: string;
  barHhmm: string;

  stateFrom: ConvictionState;
  stateTo: ConvictionState;
  anomaly: boolean;
  anomalyDetail: string;
  notified: boolean;
  withinRth: boolean;
  /** The one-line notification exactly as it was sent. */
  line: string;
}

export interface ConvictionHit {
  receivedAt: string;
  ip: string;
  fromTradingView: boolean;
  decision: string;
  reason?: string;
  signal?: string;
  action?: string;
  raw?: string;
}

export interface SpyResearchVariant {
  rules: string;
  rulesLabel: string;
  instrument: string;
  signals: number;
  priced: number;
  skipped: number;
  realisedTrades: number;
  unrealisedTrades: number;
  netPerContract: number;
  winRate: number | null;
  avgPct: number | null;
}

/** EOD backtest written by tools/streak-research. Numbers are computed
 *  deterministically there; `narrative` is the only model-written part. */
export interface SpyResearchReport {
  date: string;
  generatedAt: string;
  minTrades: number;
  closedTrades: number;
  /** False = too few trades to rank variants; the narrative says so. */
  sufficient: boolean;
  narrative: string;
  variants: SpyResearchVariant[];
}

export interface SpyConvictionResponse {
  date: string;
  /** What we BELIEVE is open. The operator trades by hand, so it can drift. */
  state: ConvictionState;
  since: string;
  entryScore: number;
  entryPx: number;
  lastSignal: string;
  lastBarTime: string;
  /** Running count of out-of-order transitions — a standing health signal. */
  anomalies: number;
  /** Last time TradingView itself reached us — the real liveness signal. */
  lastTradingViewContact: string | null;
  events: ConvictionEvent[];
  hits: ConvictionHit[];
  research: SpyResearchReport | null;
}
