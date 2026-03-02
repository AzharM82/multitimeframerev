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
