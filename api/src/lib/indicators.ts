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
// Faithful port of the two-layer ThinkScript system:
//   Layer 1: ZigZagHighLow on EMA-smoothed prices (method=average, period=5)
//   Layer 2: EIL/EIH → dir → signal → U1/D1 confirmation system
//
// Parameters from ThinkScript:
//   method = average (default) → priceh = EMA(high,5), pricel = EMA(low,5)
//   atrreversal = 2.0, atrlength = 5, revAmount = 0.05, percentamount = 0.01

interface ZigZagResult {
  signal: number;        // running signal (positive = bullish, negative = bearish)
  U1: boolean;           // bullish reversal fired this bar
  D1: boolean;           // bearish reversal fired this bar
  reversalPrice: number | null;
}

export function computeZigZag(candles: Candle[], atrLength = 5, atrReversal = 2.0): ZigZagResult[] {
  const n = candles.length;
  if (n < 2) {
    return candles.map(() => ({ signal: 0, U1: false, D1: false, reversalPrice: null }));
  }

  // ── Step 1: Smoothed prices (method = "average") ──
  // ThinkScript: mah = MovingAverage(EXPONENTIAL, high, 5)
  //              mal = MovingAverage(EXPONENTIAL, low, 5)
  const priceh = computeEMA(candles.map(c => c.high), 5);
  const pricel = computeEMA(candles.map(c => c.low), 5);

  // ── Step 2: ATR for reversal amount ──
  const atr = computeATR(candles, atrLength);

  // ── Step 3: Pass 1 — ZigZagHighLow on smoothed prices ──
  // Finds pivot highs/lows and places them retroactively at the bar where the
  // extreme actually occurred (matching ThinkScript's built-in ZigZagHighLow).
  // reversalAmount = max(close * 0.01 / 100, max(0.05, atrReversal * ATR))
  const EI: (number | null)[] = new Array(n).fill(null);
  const pivotIsUp: (boolean | null)[] = new Array(n).fill(null);

  let zzState = 1; // 1 = uptrend (tracking max priceh), -1 = downtrend (tracking min pricel)
  let extremeVal = priceh[0];
  let extremeBar = 0;

  for (let i = 1; i < n; i++) {
    const revAmt = Math.max(
      candles[i].close * 0.01 / 100,
      Math.max(0.05, atrReversal * atr[i]),
    );

    if (zzState === 1) {
      // Uptrend: track running max of smoothed high
      if (priceh[i] >= extremeVal) {
        extremeVal = priceh[i];
        extremeBar = i;
      }
      if (extremeVal - pricel[i] >= revAmt) {
        // High pivot confirmed at extremeBar
        EI[extremeBar] = priceh[extremeBar];
        pivotIsUp[extremeBar] = true;
        zzState = -1;
        extremeVal = pricel[i];
        extremeBar = i;
      }
    } else {
      // Downtrend: track running min of smoothed low
      if (pricel[i] <= extremeVal) {
        extremeVal = pricel[i];
        extremeBar = i;
      }
      if (priceh[i] - extremeVal >= revAmt) {
        // Low pivot confirmed at extremeBar
        EI[extremeBar] = pricel[extremeBar];
        pivotIsUp[extremeBar] = false;
        zzState = 1;
        extremeVal = priceh[i];
        extremeBar = i;
      }
    }
  }

  // ── Step 4: Pass 2 — Two-layer signal system ──
  // ThinkScript: EISave → chg/isUp → EIL/EIH → dir → signal → U1/D1
  let EISave = NaN;
  let prevEISave = NaN;
  let EIL = NaN;
  let EIH = NaN;
  let prevEIL = NaN;
  let prevEIH = NaN;
  let dir = 0;
  let signal = 0;
  let prevSignal = 0;
  let lastPivotIsUp: boolean | null = null;

  const results: ZigZagResult[] = [];

  for (let i = 0; i < n; i++) {
    prevEISave = EISave;
    prevEIL = EIL;
    prevEIH = EIH;
    prevSignal = signal;

    // EISave: persist last known EI value
    if (EI[i] !== null) {
      EISave = EI[i]!;
      lastPivotIsUp = pivotIsUp[i]!;
    }

    // chg and isUp: determine if this pivot is higher or lower than previous
    // ThinkScript: chg = (if EISave == priceh then priceh else pricel) - EISave[1]
    // At high pivot bars, EISave == priceh → uses priceh. Otherwise uses pricel.
    let isUp = false;
    if (!isNaN(EISave)) {
      if (isNaN(prevEISave)) {
        // First pivot — determine from pivot type
        isUp = lastPivotIsUp === true;
      } else {
        // ThinkScript checks EISave == priceh to determine price source.
        // At a high pivot bar, EISave was just set to priceh[i], so match is exact.
        // At non-pivot bars or low pivot bars, EISave != priceh[i] → uses pricel.
        const usePriceh = EI[i] !== null && lastPivotIsUp === true;
        const priceForChg = usePriceh ? priceh[i] : pricel[i];
        const chg = priceForChg - prevEISave;
        isUp = chg >= 0;
      }
    }

    // EIL / EIH: track last low/high pivot values
    // ThinkScript: EIL = if !IsNaN(EI) and !isUp then pricel else EIL[1]
    //              EIH = if !IsNaN(EI) and isUp then priceh else EIH[1]
    if (EI[i] !== null && !isUp) {
      EIL = pricel[i];
    }
    if (EI[i] !== null && isUp) {
      EIH = priceh[i];
    }

    // dir: direction based on new pivots appearing
    // ThinkScript: if EIL != EIL[1] or (pricel == EIL[1] and pricel == EISave) then 1
    //              else if EIH != EIH[1] or (priceh == EIH[1] and priceh == EISave) then -1
    const eiLChanged = !isNaN(EIL) && (isNaN(prevEIL) || Math.abs(EIL - prevEIL) > 1e-10);
    const eiHChanged = !isNaN(EIH) && (isNaN(prevEIH) || Math.abs(EIH - prevEIH) > 1e-10);
    const priceLAtEIL = !isNaN(prevEIL) && Math.abs(pricel[i] - prevEIL) < 1e-10
                        && Math.abs(pricel[i] - EISave) < 1e-10;
    const priceHAtEIH = !isNaN(prevEIH) && Math.abs(priceh[i] - prevEIH) < 1e-10
                        && Math.abs(priceh[i] - EISave) < 1e-10;

    if (eiLChanged || priceLAtEIL) {
      dir = 1;
    } else if (eiHChanged || priceHAtEIH) {
      dir = -1;
    }
    // else dir stays the same (CompoundValue behavior)

    // signal: confirmed breakout/breakdown past pivot level
    // ThinkScript: if dir > 0 and pricel > EIL then (if signal[1] <= 0 then 1 else signal[1])
    //              else if dir < 0 and priceh < EIH then (if signal[1] >= 0 then -1 else signal[1])
    //              else signal[1]
    if (dir > 0 && !isNaN(EIL) && pricel[i] > EIL) {
      if (prevSignal <= 0) {
        signal = 1;
      }
      // else signal stays the same (already bullish)
    } else if (dir < 0 && !isNaN(EIH) && priceh[i] < EIH) {
      if (prevSignal >= 0) {
        signal = -1;
      }
      // else signal stays the same (already bearish)
    }
    // else signal stays the same

    const U1 = signal > 0 && prevSignal <= 0;
    const D1 = signal < 0 && prevSignal >= 0;

    // Reversal prices from ThinkScript bubbles:
    //   U1: "Reversal:" + low  (raw low of the confirmation bar)
    //   D1: "Reversal:" + high (raw high of the confirmation bar)
    let reversalPrice: number | null = null;
    if (U1) {
      reversalPrice = Math.round(candles[i].low * 100) / 100;
    } else if (D1) {
      reversalPrice = Math.round(candles[i].high * 100) / 100;
    }

    results.push({ signal, U1, D1, reversalPrice });
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
