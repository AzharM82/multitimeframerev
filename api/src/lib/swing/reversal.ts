/**
 * Swing Strength — Lens 2: the operator's ThinkOrSwim "Jonesy Signals" study,
 * ported line by line (source: "Bullish and Bearish TOS.txt", rev 2019-04-07).
 *
 * The study has three plots:
 *
 *   Going_Up   = StochasticFull(80, 20, K=8, D=12, slowing 3, SIMPLE):
 *                FullK crosses above FullD and lowest(FullK[1], 3) < 40
 *   Going_Down = FullD crosses above FullK and highest(FullD[1], 3) > 75
 *   Bullish    = the current ZigZagHighLow leg is UP, where the zig-zag runs on
 *                EMA(5) of highs / EMA(5) of lows with percentage reversal 1%,
 *                absolute reversal 0.05 and ATR(5) × 2.0 (the "average" method).
 *
 * ZigZagHighLow as TOS computes it (its own source, paraphrased): the reversal
 * threshold on each bar is
 *     hlPivot = percentageReversal/100 + Average(TrueRange, atrLength) / close × atrReversal
 * and a leg flips when the smoothed price crosses the running extreme by
 * minMax × (1 ± hlPivot) ± absoluteReversal. The DIRECTION state is causal;
 * only the drawing of pivots looks ahead, and the operator's `isUp` (via the
 * EISave / chg trick) reduces to that state on the last bar. We compute the
 * state directly.
 *
 * Conventions that matter for matching TOS to the tick:
 *   • ExpAverage seeds with the first value (TOS), not an SMA seed.
 *   • Average(TrueRange(high, close, low), n) is a SIMPLE mean of true range on
 *     the RAW bars; TrueRange uses the previous close.
 *   • FastK = (close − lowest low(K)) / (highest high(K) − lowest low(K)) × 100 on
 *     raw bars; FullK = SMA(FastK, slowing); FullD = SMA(FullK, DPeriod).
 *   • "crosses above" on bar t: a[t−1] < b[t−1] and a[t] > b[t] (strict), as the
 *     script writes it out by hand.
 *
 * Pure functions on candle arrays; nothing here fetches.
 */

import type { Candle } from "../indicators.js";

export const JONESY = {
  stoch: { kPeriod: 8, dPeriod: 12, slowing: 3, overBought: 80, overSold: 20, upFloor: 40, downCeiling: 75, lookback: 3 },
  zz: { percentReversal: 0.01, absoluteReversal: 0.05, atrLength: 5, atrReversal: 2.0, smoothLength: 5 },
  /**
   * How many bars a Going_Up / Going_Down is treated as a live "reversal" on
   * the tab. Calibrated 2026-09-05 against the operator's TOS watchlists as of
   * the 09-04 close: 46 of the 50 bullish names had Going_Up fire within 7
   * bars (the other 4 fired 24–26 bars earlier, i.e. stale watchlist entries);
   * the bearish list was looser (11 of 20 within 9 bars). The bars-ago number
   * is always shown, so the window only decides the badge, not the data.
   */
  signalWindowBars: 7,
} as const;

export type ReversalSignal = "bull" | "bear" | null;

export interface ReversalRead {
  /** ZigZag state on the last bar: true = up leg ("Bullish" plot = 1). */
  legUp: boolean | null;
  /** Bars since the current leg began (the bar the state last flipped). */
  legBars: number | null;
  /** The running extreme of the current leg (EMA5 of highs or lows) and the pivot the leg started from. */
  legExtreme: number | null;
  legFrom: number | null;
  /** Reversal threshold on the last bar, as a % of price (hlPivot × 100 + abs/close). */
  thresholdPct: number | null;
  fullK: number | null;
  fullD: number | null;
  /** Stochastic cross fired on the last bar. */
  goingUp: boolean;
  goingDown: boolean;
  /** Bars since each cross last fired (0 = today), null if never in the window. */
  goingUpBarsAgo: number | null;
  goingDownBarsAgo: number | null;
  /** The badge: the more recent of the two crosses if it fired within the window. */
  signal: ReversalSignal;
  signalBarsAgo: number | null;
  bars: number;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/** TOS ExpAverage: seeded with the first value. */
export function expAverage(values: number[], length: number): number[] {
  const out: number[] = new Array(values.length);
  if (!values.length) return out;
  const k = 2 / (length + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = out[i - 1] + k * (values[i] - out[i - 1]);
  return out;
}

export function simpleAverage(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/** TrueRange(high, close, low) per bar; the first bar uses high − low. */
export function trueRange(c: Candle[]): number[] {
  return c.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = c[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

// ─── ZigZagHighLow state ────────────────────────────────────────────────────

export interface ZigZagState {
  /** +1 up leg, −1 down leg, 0 undefined (not enough movement yet). */
  dir: (1 | -1 | 0)[];
  minMax: number[];
  /** Threshold used on each bar, as a fraction of price. */
  hlPivot: number[];
  /** Index where the current leg began (last flip). */
  legStart: number[];
  /** Value of minMax at the moment the current leg began (the pivot it left). */
  legFrom: number[];
}

export function zigZagState(c: Candle[], p = JONESY.zz): ZigZagState {
  const n = c.length;
  const priceH = expAverage(c.map((b) => b.high), p.smoothLength);
  const priceL = expAverage(c.map((b) => b.low), p.smoothLength);
  const atr = simpleAverage(trueRange(c), p.atrLength);
  const dir: (1 | -1 | 0)[] = new Array(n).fill(0);
  const minMax: number[] = new Array(n).fill(NaN);
  const hl: number[] = new Array(n).fill(NaN);
  const legStart: number[] = new Array(n).fill(0);
  const legFrom: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    // TOS: hlPivot = pct/100 + Average(TrueRange, atrLength) / close * atrReversal (ATR term only once it exists)
    const atrTerm = atr[i] === null ? 0 : (atr[i]! / c[i].close) * p.atrReversal;
    const h = p.percentReversal + atrTerm;
    hl[i] = h;
    if (i === 0) { dir[i] = 0; minMax[i] = priceL[0]; legStart[i] = 0; legFrom[i] = priceL[0]; continue; }
    const prevDir = dir[i - 1], prevMM = minMax[i - 1];
    const upBreak = priceH[i] >= prevMM * (1 + h) + p.absoluteReversal;
    const downBreak = priceL[i] <= prevMM * (1 - h) - p.absoluteReversal;
    if (prevDir === 0) {
      if (upBreak) { dir[i] = 1; minMax[i] = priceH[i]; legStart[i] = i; legFrom[i] = prevMM; }
      else if (downBreak) { dir[i] = -1; minMax[i] = priceL[i]; legStart[i] = i; legFrom[i] = prevMM; }
      else { dir[i] = 0; minMax[i] = prevMM; legStart[i] = legStart[i - 1]; legFrom[i] = legFrom[i - 1]; }
    } else if (prevDir === 1) {
      if (downBreak) { dir[i] = -1; minMax[i] = priceL[i]; legStart[i] = i; legFrom[i] = prevMM; }
      else { dir[i] = 1; minMax[i] = Math.max(priceH[i], prevMM); legStart[i] = legStart[i - 1]; legFrom[i] = legFrom[i - 1]; }
    } else {
      if (upBreak) { dir[i] = 1; minMax[i] = priceH[i]; legStart[i] = i; legFrom[i] = prevMM; }
      else { dir[i] = -1; minMax[i] = Math.min(priceL[i], prevMM); legStart[i] = legStart[i - 1]; legFrom[i] = legFrom[i - 1]; }
    }
  }
  return { dir, minMax, hlPivot: hl, legStart, legFrom };
}

// ─── StochasticFull ─────────────────────────────────────────────────────────

export function stochasticFull(c: Candle[], p = JONESY.stoch): { fullK: (number | null)[]; fullD: (number | null)[] } {
  const n = c.length;
  const fastK: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < p.kPeriod - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p.kPeriod + 1; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    fastK[i] = hh === ll ? 0 : ((c[i].close - ll) / (hh - ll)) * 100;
  }
  const first = p.kPeriod - 1;
  const kValid = fastK.slice(first);
  const fullKTail = simpleAverage(kValid, p.slowing);
  const fullK: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < fullKTail.length; i++) fullK[first + i] = fullKTail[i];
  const kStart = fullK.findIndex((v) => v !== null);
  const fullD: (number | null)[] = new Array(n).fill(null);
  if (kStart >= 0) {
    const dTail = simpleAverage(fullK.slice(kStart) as number[], p.dPeriod);
    for (let i = 0; i < dTail.length; i++) fullD[kStart + i] = dTail[i];
  }
  return { fullK, fullD };
}

export function stochCrosses(c: Candle[], p = JONESY.stoch): { goingUp: boolean[]; goingDown: boolean[]; fullK: (number | null)[]; fullD: (number | null)[] } {
  const { fullK, fullD } = stochasticFull(c, p);
  return { ...crossesFromKD(fullK, fullD, p), fullK, fullD };
}

/** The two cross rules on already-computed K and D series (kept separate so they can be tested by hand). */
export function crossesFromKD(fullK: (number | null)[], fullD: (number | null)[], p = JONESY.stoch): { goingUp: boolean[]; goingDown: boolean[] } {
  const n = fullK.length;
  const goingUp: boolean[] = new Array(n).fill(false);
  const goingDown: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    const k0 = fullK[i], d0 = fullD[i], k1 = fullK[i - 1], d1 = fullD[i - 1];
    if (k0 === null || d0 === null || k1 === null || d1 === null) continue;
    // lowest(slowK[1], 3): the lowest of K over the 3 bars ending at i−1
    let lowK = Infinity, highD = -Infinity;
    for (let j = Math.max(0, i - p.lookback); j <= i - 1; j++) {
      if (fullK[j] !== null) lowK = Math.min(lowK, fullK[j]!);
      if (fullD[j] !== null) highD = Math.max(highD, fullD[j]!);
    }
    goingUp[i] = k1 < d1 && k0 > d0 && lowK < p.upFloor;
    goingDown[i] = d1 < k1 && d0 > k0 && highD > p.downCeiling;
  }
  return { goingUp, goingDown };
}

/** The badge rule: the more recent cross wins if it fired inside the window. */
export function badgeFor(upAgo: number | null, downAgo: number | null, window = JONESY.signalWindowBars): { signal: ReversalSignal; signalBarsAgo: number | null } {
  const upLive = upAgo !== null && upAgo < window, downLive = downAgo !== null && downAgo < window;
  if (upLive && (!downLive || upAgo! <= downAgo!)) return { signal: "bull", signalBarsAgo: upAgo };
  if (downLive) return { signal: "bear", signalBarsAgo: downAgo };
  return { signal: null, signalBarsAgo: null };
}

// ─── The read for one stock ─────────────────────────────────────────────────

export function computeReversal(c: Candle[]): ReversalRead {
  const n = c.length;
  const empty: ReversalRead = {
    legUp: null, legBars: null, legExtreme: null, legFrom: null, thresholdPct: null,
    fullK: null, fullD: null, goingUp: false, goingDown: false, goingUpBarsAgo: null, goingDownBarsAgo: null,
    signal: null, signalBarsAgo: null, bars: n,
  };
  if (n < 30) return empty;
  const zz = zigZagState(c);
  const st = stochCrosses(c);
  const last = n - 1;
  const lastUp = st.goingUp.lastIndexOf(true), lastDown = st.goingDown.lastIndexOf(true);
  const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const upAgo = lastUp < 0 ? null : last - lastUp;
  const downAgo = lastDown < 0 ? null : last - lastDown;
  const { signal, signalBarsAgo } = badgeFor(upAgo, downAgo);
  return {
    signal, signalBarsAgo,
    legUp: zz.dir[last] === 0 ? null : zz.dir[last] === 1,
    legBars: zz.dir[last] === 0 ? null : last - zz.legStart[last],
    legExtreme: r2(zz.minMax[last]),
    legFrom: r2(zz.legFrom[last]),
    thresholdPct: r2(zz.hlPivot[last] * 100 + (JONESY.zz.absoluteReversal / c[last].close) * 100),
    fullK: r2(st.fullK[last]), fullD: r2(st.fullD[last]),
    goingUp: st.goingUp[last], goingDown: st.goingDown[last],
    goingUpBarsAgo: lastUp < 0 ? null : last - lastUp,
    goingDownBarsAgo: lastDown < 0 ? null : last - lastDown,
    bars: n,
  };
}
