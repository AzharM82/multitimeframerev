/**
 * Multi-Timeframe Reversal Indicator Engine
 * Ported from ThinkScript: EMA Crossover + ZigZag Reversal Detection
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export type SignalDirection = "bullish" | "bearish" | "neutral";
export type EmaColor = "green" | "red" | "neutral";
export type Timeframe = "1W" | "1D" | "65m" | "10m";

export interface TimeframeSignal {
  timeframe: Timeframe;
  direction: SignalDirection;
  emaColor: EmaColor;
  reversalPrice: number | null;
  lastBarTime: string | null;
}

export interface StockScanResult {
  ticker: string;
  price: number;
  atr: number;
  rvol: number;
  volatility: "high" | "low";
  industry: string;
  signals: Record<Timeframe, TimeframeSignal>;
  confluence: "bullish" | "bearish" | null;
  lastUpdated: string;
}

// ─── EMA Calculation ─────────────────────────────────────────────────────────

export function computeEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// ─── ATR Calculation (Wilder's method) ───────────────────────────────────────

export function computeATR(candles: Candle[], period: number): number[] {
  if (candles.length < 2) return candles.map(() => 0);

  const tr: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }

  // Wilder's smoothing: first ATR is SMA, then recursive
  const atr: number[] = new Array(candles.length).fill(0);
  if (candles.length < period) {
    // Not enough data — just use running average
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += tr[i];
      atr[i] = sum / (i + 1);
    }
    return atr;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i];
    atr[i] = sum / (i + 1); // partial average for early bars
  }
  atr[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  return atr;
}

// ─── Component 1: EMA Crossover Signal (ThinkScript lines 1-46) ─────────────

interface EmaSignalBar {
  buysignal: boolean;
  sellsignal: boolean;
  colorbar: "green" | "red" | "neutral"; // 1=green, 2=red, 3=neutral
  buySignalFired: boolean;    // transition from 0→1
  sellSignalFired: boolean;   // transition from 0→1
  momentumDown: boolean;      // buy→0
  momentumUp: boolean;        // sell→0
}

export function computeEmaSignals(candles: Candle[]): EmaSignalBar[] {
  const closes = candles.map((c) => c.close);
  const ema9 = computeEMA(closes, 9);
  const ema14 = computeEMA(closes, 14);
  const ema21 = computeEMA(closes, 21);

  const results: EmaSignalBar[] = [];
  let prevBuysignal = 0;
  let prevSellsignal = 0;

  for (let i = 0; i < candles.length; i++) {
    const buy = ema9[i] > ema14[i] && ema14[i] > ema21[i] && candles[i].low > ema9[i];
    const stopbuy = ema9[i] <= ema14[i];
    const prevBuy = i > 0
      ? ema9[i - 1] > ema14[i - 1] && ema14[i - 1] > ema21[i - 1] && candles[i - 1].low > ema9[i - 1]
      : false;
    const buynow = !prevBuy && buy;

    let buysignal: number;
    if (buynow && !stopbuy) {
      buysignal = 1;
    } else if (prevBuysignal === 1 && stopbuy) {
      buysignal = 0;
    } else {
      buysignal = prevBuysignal;
    }

    const sell = ema9[i] < ema14[i] && ema14[i] < ema21[i] && candles[i].high < ema9[i];
    const stopsell = ema9[i] >= ema14[i];
    const prevSell = i > 0
      ? ema9[i - 1] < ema14[i - 1] && ema14[i - 1] < ema21[i - 1] && candles[i - 1].high < ema9[i - 1]
      : false;
    const sellnow = !prevSell && sell;

    let sellsignal: number;
    if (sellnow && !stopsell) {
      sellsignal = 1;
    } else if (prevSellsignal === 1 && stopsell) {
      sellsignal = 0;
    } else {
      sellsignal = prevSellsignal;
    }

    const colorbar: "green" | "red" | "neutral" =
      buysignal === 1 ? "green" : sellsignal === 1 ? "red" : "neutral";

    results.push({
      buysignal: buysignal === 1,
      sellsignal: sellsignal === 1,
      colorbar,
      buySignalFired: prevBuysignal === 0 && buysignal === 1,
      sellSignalFired: prevSellsignal === 0 && sellsignal === 1,
      momentumDown: prevBuysignal === 1 && buysignal === 0,
      momentumUp: prevSellsignal === 1 && sellsignal === 0,
    });

    prevBuysignal = buysignal;
    prevSellsignal = sellsignal;
  }

  return results;
}

// ─── Component 2: ZigZag Reversal Detection (ThinkScript lines 48-112) ──────

interface ZigZagResult {
  signal: number;        // running signal (positive = bullish, negative = bearish)
  U1: boolean;           // bullish reversal fired this bar
  D1: boolean;           // bearish reversal fired this bar
  reversalPrice: number | null;
}

export function computeZigZag(candles: Candle[], atrLength = 5, atrReversal = 0.5): ZigZagResult[] {
  if (candles.length < 2) {
    return candles.map(() => ({ signal: 0, U1: false, D1: false, reversalPrice: null }));
  }

  const atr = computeATR(candles, atrLength);
  const n = candles.length;
  const results: ZigZagResult[] = [];

  // Standard ZigZag using HIGH/LOW with ATR-based reversal amount.
  // Uptrend: track running max(high). Reversal down when max(high) - low >= ATR * factor.
  // Downtrend: track running min(low). Reversal up when high - min(low) >= ATR * factor.
  // Signal = current zigzag direction: +1 = uptrend (bullish), -1 = downtrend (bearish).
  // U1/D1 fire on direction changes (zigzag pivot points).
  let ei = candles[0].high;
  let state = 1; // 1 = uptrend, -1 = downtrend
  let prevState = 1;

  for (let i = 0; i < n; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const ra = atrReversal * atr[i];
    prevState = state;
    let reversalPrice: number | null = null;

    if (i === 0) {
      // Initialize
      results.push({ signal: 0, U1: false, D1: false, reversalPrice: null });
      continue;
    }

    if (state === 1) {
      if (h >= ei) {
        ei = h; // new high in uptrend
      } else if (ei - l >= ra) {
        // Reversal DOWN — peak was at ei, now dropping
        reversalPrice = Math.round(ei * 100) / 100; // the high pivot
        state = -1;
        ei = l;
      }
    } else {
      if (l <= ei) {
        ei = l; // new low in downtrend
      } else if (h - ei >= ra) {
        // Reversal UP — trough was at ei, now rising
        reversalPrice = Math.round(ei * 100) / 100; // the low pivot
        state = 1;
        ei = h;
      }
    }

    const U1 = state === 1 && prevState === -1;  // just reversed UP (bullish)
    const D1 = state === -1 && prevState === 1;   // just reversed DOWN (bearish)

    results.push({ signal: state, U1, D1, reversalPrice });
  }

  return results;
}

// ─── Extract Latest Signal for Dashboard ─────────────────────────────────────

export function getLatestSignal(candles: Candle[], timeframe: Timeframe): TimeframeSignal {
  if (candles.length === 0) {
    return { timeframe, direction: "neutral", emaColor: "neutral", reversalPrice: null, lastBarTime: null };
  }

  const emaSignals = computeEmaSignals(candles);
  const zigzag = computeZigZag(candles);
  const lastEma = emaSignals[emaSignals.length - 1];
  const lastZz = zigzag[zigzag.length - 1];

  // Direction: EMA colorbar is the primary signal (matches chart bar coloring).
  // Green bars = buy signal active (EMA9>EMA14>EMA21, low>EMA9) → bullish.
  // Red bars = sell signal active → bearish.
  // Neutral EMA: fall back to zigzag signal which carries forward last reversal.
  let direction: SignalDirection;
  if (lastEma.colorbar === "green") {
    direction = "bullish";
  } else if (lastEma.colorbar === "red") {
    direction = "bearish";
  } else {
    direction = lastZz.signal > 0 ? "bullish" : lastZz.signal < 0 ? "bearish" : "neutral";
  }

  // Find when the current direction was triggered (scan backwards for matching event)
  let reversalPrice: number | null = null;
  let lastBarTime: string | null = null;

  for (let i = candles.length - 1; i >= 0; i--) {
    if (direction === "bullish" && (emaSignals[i].buySignalFired || zigzag[i].U1)) {
      if (zigzag[i].U1) reversalPrice = zigzag[i].reversalPrice;
      lastBarTime = new Date(candles[i].timestamp).toISOString();
      break;
    }
    if (direction === "bearish" && (emaSignals[i].sellSignalFired || zigzag[i].D1)) {
      if (zigzag[i].D1) reversalPrice = zigzag[i].reversalPrice;
      lastBarTime = new Date(candles[i].timestamp).toISOString();
      break;
    }
  }

  if (!lastBarTime) {
    lastBarTime = new Date(candles[candles.length - 1].timestamp).toISOString();
  }

  return {
    timeframe,
    direction,
    emaColor: lastEma.colorbar,
    reversalPrice,
    lastBarTime,
  };
}

// ─── Full Stock Scan ─────────────────────────────────────────────────────────

// ─── Relative Volume ─────────────────────────────────────────────────────────

function computeRVOL(dailyCandles: Candle[], period = 20): number {
  if (dailyCandles.length < 2) return 0;

  const todayVol = dailyCandles[dailyCandles.length - 1].volume;
  // Average volume over prior N days (excluding today)
  const priorCandles = dailyCandles.slice(-period - 1, -1);
  if (priorCandles.length === 0) return 0;

  const avgVol = priorCandles.reduce((sum, c) => sum + c.volume, 0) / priorCandles.length;
  if (avgVol === 0) return 0;

  return Math.round((todayVol / avgVol) * 100) / 100;
}

// ─── Full Stock Scan ─────────────────────────────────────────────────────────

export function scanStock(
  ticker: string,
  weeklyCandles: Candle[],
  dailyCandles: Candle[],
  candles65m: Candle[],
  candles10m: Candle[],
  industry = "—",
): StockScanResult {
  // ATR from daily candles for volatility categorization
  const dailyAtr = computeATR(dailyCandles, 14);
  const currentAtr = dailyAtr.length > 0 ? dailyAtr[dailyAtr.length - 1] : 0;
  const currentPrice = dailyCandles.length > 0 ? dailyCandles[dailyCandles.length - 1].close : 0;
  const rvol = computeRVOL(dailyCandles);

  const signals: Record<Timeframe, TimeframeSignal> = {
    "1W": getLatestSignal(weeklyCandles, "1W"),
    "1D": getLatestSignal(dailyCandles, "1D"),
    "65m": getLatestSignal(candles65m, "65m"),
    "10m": getLatestSignal(candles10m, "10m"),
  };

  // Confluence: all 4 timeframes agree on direction
  const directions = Object.values(signals).map((s) => s.direction);
  const allBullish = directions.every((d) => d === "bullish");
  const allBearish = directions.every((d) => d === "bearish");

  return {
    ticker,
    price: currentPrice,
    atr: Math.round(currentAtr * 100) / 100,
    rvol,
    volatility: currentAtr >= 3 ? "high" : "low",
    industry,
    signals,
    confluence: allBullish ? "bullish" : allBearish ? "bearish" : null,
    lastUpdated: new Date().toISOString(),
  };
}
