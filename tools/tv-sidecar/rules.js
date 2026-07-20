'use strict';

/**
 * Scoring rubric: chart facts in, bullish/bearish evidence rows out.
 *
 * No LLM. Every row here is arithmetic on values read off the chart, so the
 * output is reproducible and this file is the thing to argue with when the
 * scoring feels wrong.
 *
 * Weights encode AUTHORITY, not agreement count. Twelve momentum indicators
 * nodding along is one signal counted twelve times, so momentum sits at
 * weight 1 while structure (daily trend, ATR trigger, VWAP) sits at 3.
 *
 * Indicator settings this rubric assumes (read live off the chart, not guessed):
 *   Higher-TF MAs .... EMA 10 / EMA 21 / SMA 50, all 1D, ohlc4
 *   Saty ATR Levels .. Day mode, ATR 14, trigger 0.236, anchored to prev close
 *   Saty Pivot Ribbon  EMA 9 / 21 / 34, conviction 13 / 48, Time Warp 5m
 *   Simple MA ........ 195 on 10m == 5 sessions (regular hours only)
 *   RAHUL ATR ........ period 10, mult 2.5 -> its "ATR" plot is a SuperTrend
 *                      TRAILING STOP LINE, not a volatility magnitude
 */

/** Level crosses inside this band are noise, not signal. */
const DEADBAND_PCT = 0.15;

/**
 * Tradeability gates. Failing one drops the ticker rather than scoring it.
 *
 * NOTE: do NOT gate on Swing Data's ADR%/ATR%. Those are computed on the CHART
 * timeframe, not daily - on a 10m chart NBIS reads ATR% 1.32% while its true
 * daily ATR is ~13.9%. A fixed threshold against a timeframe-relative number
 * silently filtered out NSE:NIFTY (ADR% 0.16% per 10m bar) as "untradeable".
 * We derive true daily ATR from the Saty levels instead, which is
 * timeframe-independent.
 */
const GATES = {
  minAvgDollarVol: 3_000_000, // $3M/day
  minDailyAtrPct: 0.75        // daily range must be worth trading
};

// ---------------------------------------------------------------- parsing

/**
 * TradingView renders negatives with U+2212 MINUS SIGN, not ASCII hyphen, and
 * suffixes magnitudes (K/M/B). Parsing this wrong silently flips signs, so it
 * is centralised here.
 */
function num(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim()
    .replace(/−/g, '-')   // unicode minus -> ASCII
    .replace(/[$,\s]/g, '')
    .replace(/%$/, '');
  let mult = 1;
  const m = s.match(/^(-?[\d.]+)([KMB])$/i);
  if (m) {
    s = m[1];
    mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()];
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

/** Percentage difference of `price` from `level`. */
function pctFrom(price, level) {
  if (price == null || level == null || level === 0) return null;
  return ((price - level) / Math.abs(level)) * 100;
}

/**
 * Side of a level with the noise deadband applied.
 * Returns 'above' | 'below' | 'flat' (flat === inside the deadband).
 */
function side(price, level, band = DEADBAND_PCT) {
  const d = pctFrom(price, level);
  if (d === null) return null;
  if (Math.abs(d) < band) return 'flat';
  return d > 0 ? 'above' : 'below';
}

/** Find a study by fuzzy name match. */
function study(snap, pattern) {
  const key = Object.keys(snap.studies || {}).find((k) => pattern.test(k));
  return key ? snap.studies[key] : null;
}

function val(snap, pattern, field) {
  const s = study(snap, pattern);
  if (!s) return null;
  return num(s.values[field]);
}

/** Flatten a Pine table's 2-cell rows into a label->value dict. */
function tableDict(s) {
  const out = {};
  if (!s || !s.tables) return out;
  for (const table of s.tables) {
    for (const row of table) {
      if (row.length >= 2) out[row[0].trim()] = row[1].trim();
    }
  }
  return out;
}

/** Look up a table row whose LABEL matches a pattern (keys can be dynamic). */
function dictMatch(dict, pattern) {
  const key = Object.keys(dict).find((k) => pattern.test(k));
  return key ? { key, value: dict[key] } : null;
}

// ---------------------------------------------------------------- facts

/** Collect a Pine table's single-cell rows (labels with no value column). */
function tableLabels(s) {
  const out = [];
  if (!s || !s.tables) return out;
  for (const table of s.tables) {
    for (const row of table) if (row.length === 1) out.push(row[0].trim());
  }
  return out;
}

function extractFacts(snap) {
  const swingStudy = study(snap, /Swing Data/i);
  const swing = tableDict(swingStudy);
  const stackTable = study(snap, /Volume Stack/i);
  let buyPct = null;
  if (stackTable && stackTable.tables.length) {
    const first = stackTable.tables[0][0];
    if (first && first.length >= 1) buyPct = num(first[0]);
  }

  const price =
    val(snap, /TheVWAP/i, 'close') ??
    val(snap, /Pivot Ribbon/i, 'PlotCandle#4') ??
    null;

  // True daily ATR, back-solved from the Saty trigger offset. Verified against
  // all 13 published levels on NBIS: (177.61 - 171.77) / 0.236 = 24.75.
  const prevCloseV = val(snap, /Saty ATR Levels/i, 'Previous Close');
  const upperTriggerV = val(snap, /Saty ATR Levels/i, 'Upper Trigger');
  const dailyAtr =
    prevCloseV != null && upperTriggerV != null
      ? (upperTriggerV - prevCloseV) / 0.236
      : null;

  // Swing Data reports sector/industry as "N/A" for non-US symbols, but still
  // prints an RS row benchmarked against SPY - comparing NSE:NIFTY to the S&P
  // is noise, so the sector signal is only trusted when sector data is real.
  const labels = tableLabels(swingStudy);
  const sectorValid = labels.length > 0 && labels.some((l) => l && l !== 'N/A');

  return {
    symbol: snap.symbol,
    resolution: snap.resolution,
    price,
    vwap: val(snap, /TheVWAP/i, 'Intraday VWAP'),

    dailyFast: val(snap, /higher Timeframes/i, 'Moving Average 1'), // EMA 10 1D
    dailyMid: val(snap, /higher Timeframes/i, 'Moving Average 2'),  // EMA 21 1D
    dailySlow: val(snap, /higher Timeframes/i, 'Moving Average 3'), // SMA 50 1D
    sma5d: val(snap, /^Simple Moving Average/i, 'MA'),              // 195 on 10m

    ribFast: val(snap, /Pivot Ribbon/i, 'Fast EMA'),
    ribPivot: val(snap, /Pivot Ribbon/i, 'Pivot EMA'),
    ribSlow: val(snap, /Pivot Ribbon/i, 'Slow EMA'),

    phase: val(snap, /Phase Oscillator/i, 'Phase Oscillator'),
    momentum: val(snap, /Squeeze Pro/i, 'Momentum Oscillator'),
    squeeze: val(snap, /Squeeze Pro/i, 'Squeeze'),

    rahulStop: val(snap, /RAHUL/i, 'ATR'), // trailing stop line, see header
    rahulBuy: val(snap, /RAHUL/i, 'Buy'),
    rahulSell: val(snap, /RAHUL/i, 'Sell'),

    prevClose: val(snap, /Saty ATR Levels/i, 'Previous Close'),
    upperTrigger: val(snap, /Saty ATR Levels/i, 'Upper Trigger'),
    lowerTrigger: val(snap, /Saty ATR Levels/i, 'Lower Trigger'),
    gate382Up: val(snap, /Saty ATR Levels/i, '38.2%'),
    gate618Up: val(snap, /Saty ATR Levels/i, '61.8%'),
    gate382Dn: val(snap, /Saty ATR Levels/i, '-38.2%'),

    vpUp: val(snap, /Volume Profile/i, 'Up'),
    vpDown: val(snap, /Volume Profile/i, 'Down'),
    buyVolPct: buyPct,

    d1: num(swing['1-Day % △'] ?? val(snap, /Darvas/i, '1-Day % △')),
    relVol: num(swing['Rel. Vol']),
    volBuzz: num(swing['Vol. Buzz']),
    adrPct: num(swing['ADR%']),
    lodDist: num(swing['LoD dist.']),
    offHigh: num(swing['Off 52W High']),
    udRatio: num(swing['U/D Ratio']),
    avgDollarVol: num(swing['Avg $ Vol']),

    darvas1D: num((study(snap, /Darvas/i) || { values: {} }).values['1-Day % △']),
    darvas1W: num((study(snap, /Darvas/i) || { values: {} }).values['1-Week % △']),
    darvas1M: num((study(snap, /Darvas/i) || { values: {} }).values['1-Month % △']),
    ytd: num((study(snap, /Darvas/i) || { values: {} }).values['YTD % △']),

    // Swing Data labels its sector row dynamically, e.g. "XLK (RS 57)" -> "+1.59%".
    sectorLabel: (dictMatch(swing, /\(RS ?\d+\)/) || {}).key ?? null,
    sectorChange: sectorValid ? num((dictMatch(swing, /\(RS ?\d+\)/) || {}).value) : null,
    sectorValid,

    dailyAtr,
    dailyAtrPct: dailyAtr != null && price ? (dailyAtr / price) * 100 : null
  };
}

// ---------------------------------------------------------------- rules

/**
 * Each rule returns {side:'bull'|'bear', weight, signal, detail} or null.
 * `f` is the facts object. Order here is the order shown in the UI.
 */
const RULES = [
  // --- weight 3: structure -------------------------------------------------
  function dailyTrend(f) {
    const { price, dailyFast, dailyMid, dailySlow } = f;
    if ([price, dailyFast, dailyMid, dailySlow].some((v) => v == null)) return null;
    const detail = `${price} vs ${dailyFast} / ${dailyMid} / ${dailySlow}`;
    if (price > dailyFast && dailyFast > dailyMid && dailyMid > dailySlow)
      return { side: 'bull', weight: 3, signal: 'Daily EMA stack aligned up', detail, bias: 'bull' };
    if (price < dailyFast && dailyFast < dailyMid && dailyMid < dailySlow)
      return { side: 'bear', weight: 3, signal: 'Daily EMA stack fully inverted', detail, bias: 'bear' };
    return null; // mixed daily = no bias, scores nothing
  },

  function atrTrigger(f) {
    const { price, upperTrigger, lowerTrigger } = f;
    if (price == null) return null;
    if (upperTrigger != null && side(price, upperTrigger) === 'above')
      return {
        side: 'bull', weight: 3, signal: 'Above Saty Upper Trigger',
        detail: `${price} > ${upperTrigger} (ATR day triggered long)`
      };
    if (lowerTrigger != null && side(price, lowerTrigger) === 'below')
      return {
        side: 'bear', weight: 3, signal: 'Below Saty Lower Trigger',
        detail: `${price} < ${lowerTrigger} (ATR day triggered short)`
      };
    return null; // between triggers = no ATR day yet
  },

  function vwapSide(f) {
    const s = side(f.price, f.vwap);
    if (!s || s === 'flat') return null; // deadband: 9c on a $178 stock is noise
    const d = pctFrom(f.price, f.vwap).toFixed(2);
    return s === 'above'
      ? { side: 'bull', weight: 3, signal: 'Above intraday VWAP', detail: `${f.price} vs ${f.vwap} (+${d}%)` }
      : { side: 'bear', weight: 3, signal: 'Below intraday VWAP', detail: `${f.price} vs ${f.vwap} (${d}%)` };
  },

  // --- weight 2: confirming ------------------------------------------------
  function goldenGate(f) {
    const { price, gate382Up, gate618Up, gate382Dn } = f;
    if (price == null) return null;
    if (gate382Up != null && price >= gate382Up)
      return {
        side: 'bull', weight: 2, signal: 'Golden Gate open (38.2% tagged)',
        detail: `${price} >= ${gate382Up}, next target ${gate618Up ?? 'n/a'}`
      };
    if (gate382Dn != null && price <= gate382Dn)
      return {
        side: 'bear', weight: 2, signal: 'Golden Gate open downside',
        detail: `${price} <= ${gate382Dn}`
      };
    return null;
  },

  function ribbon(f) {
    const { price, ribFast, ribPivot, ribSlow } = f;
    if ([price, ribFast, ribPivot, ribSlow].some((v) => v == null)) return null;
    const detail = `fast ${ribFast} / pivot ${ribPivot} / slow ${ribSlow}, price ${price}`;
    if (ribFast > ribPivot && ribPivot > ribSlow && price > ribFast)
      return { side: 'bull', weight: 2, signal: 'Ribbon stacked bullish', detail };
    if (ribFast < ribPivot && ribPivot < ribSlow && price < ribFast)
      return { side: 'bear', weight: 2, signal: 'Ribbon inverted, price below all', detail };
    return null;
  },

  function phaseOscillator(f) {
    const p = f.phase;
    if (p == null) return null;
    if (p >= 61.8)
      return { side: 'bear', weight: 2, signal: 'Extended up - fade risk', detail: `Phase Oscillator ${p} (>61.8 distribution)` };
    if (p <= -61.8)
      return { side: 'bull', weight: 2, signal: 'Extended down - bounce zone', detail: `Phase Oscillator ${p} (<-61.8 accumulation)` };
    if (p > 0) return { side: 'bull', weight: 2, signal: 'Phase Oscillator positive', detail: `${p}` };
    if (p < 0) return { side: 'bear', weight: 2, signal: 'Phase Oscillator negative', detail: `${p}` };
    return null;
  },

  function rahulTrail(f) {
    const s = side(f.price, f.rahulStop);
    if (!s || s === 'flat') return null;
    return s === 'above'
      ? { side: 'bull', weight: 2, signal: 'Above RAHUL trailing stop', detail: `${f.price} > ${f.rahulStop}` }
      : { side: 'bear', weight: 2, signal: 'Below RAHUL trailing stop', detail: `${f.price} < ${f.rahulStop}` };
  },

  function relativeVolume(f) {
    if (f.relVol == null || f.relVol <= 200) return null;
    // Volume is conviction, not direction - it amplifies whichever side is
    // already in control, so it attaches to the intraday trigger's side.
    const dir = f.price != null && f.upperTrigger != null && f.price > f.upperTrigger ? 'bull' : 'bear';
    return {
      side: dir, weight: 2, signal: 'Relative volume surge',
      detail: `Rel. Vol ${f.relVol}%${f.volBuzz != null ? `, Buzz ${f.volBuzz}%` : ''}`
    };
  },

  function volumeStack(f) {
    if (f.buyVolPct == null) return null;
    if (f.buyVolPct >= 65)
      return { side: 'bull', weight: 2, signal: 'Buy-side volume dominant', detail: `${f.buyVolPct}% buying` };
    if (f.buyVolPct <= 35)
      return { side: 'bear', weight: 2, signal: 'Sell-side volume dominant', detail: `${100 - f.buyVolPct}% selling` };
    return null;
  },

  function fiveDaySma(f) {
    const s = side(f.price, f.sma5d);
    if (!s || s === 'flat') return null;
    const d = pctFrom(f.price, f.sma5d).toFixed(1);
    return s === 'above'
      ? { side: 'bull', weight: 2, signal: 'Above 5-day SMA', detail: `${f.sma5d} (+${d}%)` }
      : { side: 'bear', weight: 2, signal: 'Below 5-day SMA', detail: `${f.sma5d} (${d}%)` };
  },

  // --- weight 1: texture ---------------------------------------------------
  function squeezeMomentum(f) {
    if (f.momentum == null || f.momentum === 0) return null;
    return f.momentum > 0
      ? { side: 'bull', weight: 1, signal: 'Squeeze momentum positive', detail: `${f.momentum}` }
      : { side: 'bear', weight: 1, signal: 'Squeeze momentum negative', detail: `${f.momentum}` };
  },

  function upDownRatio(f) {
    if (f.udRatio == null) return null;
    if (f.udRatio > 1) return { side: 'bull', weight: 1, signal: 'U/D ratio positive', detail: `${f.udRatio}` };
    if (f.udRatio < 1) return { side: 'bear', weight: 1, signal: 'U/D ratio negative', detail: `${f.udRatio}` };
    return null;
  },

  function lodDistance(f) {
    if (f.lodDist == null) return null;
    if (f.lodDist >= 60) return { side: 'bull', weight: 1, signal: 'Holding upper day range', detail: `LoD dist. ${f.lodDist}%` };
    if (f.lodDist <= 25) return { side: 'bear', weight: 1, signal: 'Pinned near day low', detail: `LoD dist. ${f.lodDist}%` };
    return null;
  },

  function offHigh(f) {
    if (f.offHigh == null) return null;
    if (f.offHigh <= -25) return { side: 'bear', weight: 1, signal: 'Well off 52W high', detail: `${f.offHigh}%` };
    if (f.offHigh >= -5) return { side: 'bull', weight: 1, signal: 'Near 52W high', detail: `${f.offHigh}%` };
    return null;
  },

  function shortHorizon(f) {
    const parts = [];
    if (f.darvas1W != null) parts.push(`1W ${f.darvas1W}%`);
    if (f.darvas1M != null) parts.push(`1M ${f.darvas1M}%`);
    if (!parts.length) return null;
    const sum = (f.darvas1W ?? 0) + (f.darvas1M ?? 0);
    if (sum === 0) return null;
    return sum > 0
      ? { side: 'bull', weight: 1, signal: 'Week/month green', detail: parts.join(', ') }
      : { side: 'bear', weight: 1, signal: 'Week/month red', detail: parts.join(', ') };
  },

  function todayChange(f) {
    if (f.darvas1D == null || f.darvas1D === 0) return null;
    return f.darvas1D > 0
      ? { side: 'bull', weight: 1, signal: 'Up on the day', detail: `1D +${f.darvas1D}%` }
      : { side: 'bear', weight: 1, signal: 'Down on the day', detail: `1D ${f.darvas1D}%` };
  },

  function sectorTrend(f) {
    if (f.sectorChange == null || f.sectorChange === 0) return null;
    return f.sectorChange > 0
      ? { side: 'bull', weight: 1, signal: 'Sector green', detail: `${f.sectorLabel} +${f.sectorChange}%` }
      : { side: 'bear', weight: 1, signal: 'Sector red', detail: `${f.sectorLabel} ${f.sectorChange}%` };
  },

  // Long-term trend, from YTD only. "Above 52W Low" says the same thing, so
  // scoring both would double-count one piece of evidence.
  function longTermTrend(f) {
    if (f.ytd == null) return null;
    if (f.ytd >= 25) return { side: 'bull', weight: 1, signal: 'Long-term uptrend intact', detail: `YTD +${f.ytd}%` };
    if (f.ytd <= -25) return { side: 'bear', weight: 1, signal: 'Long-term downtrend', detail: `YTD ${f.ytd}%` };
    return null;
  }
];

// ---------------------------------------------------------------- scoring

function checkGates(f) {
  const failures = [];
  if (f.avgDollarVol != null && f.avgDollarVol < GATES.minAvgDollarVol)
    failures.push(`Avg $ Vol ${(f.avgDollarVol / 1e6).toFixed(2)}M < ${GATES.minAvgDollarVol / 1e6}M`);
  if (f.dailyAtrPct != null && f.dailyAtrPct < GATES.minDailyAtrPct)
    failures.push(`daily ATR ${f.dailyAtrPct.toFixed(2)}% < ${GATES.minDailyAtrPct}%`);
  return failures;
}

function score(snap) {
  const facts = extractFacts(snap);
  const gateFailures = checkGates(facts);

  const bullish = [];
  const bearish = [];
  let dailyBias = null;

  for (const rule of RULES) {
    let row;
    try { row = rule(facts); } catch (e) { continue; }
    if (!row) continue;
    if (row.bias) dailyBias = row.bias;
    (row.side === 'bull' ? bullish : bearish).push(row);
  }

  const total = (rows) => rows.reduce((a, r) => a + r.weight, 0);
  const bullScore = total(bullish);
  const bearScore = total(bearish);
  const net = bullScore - bearScore;

  let verdict;
  if (gateFailures.length) verdict = 'FILTERED';
  else if (dailyBias === 'bear' && net > 0) verdict = 'COUNTER-TREND LONG';
  else if (dailyBias === 'bull' && net < 0) verdict = 'COUNTER-TREND SHORT';
  else if (dailyBias === 'bear') verdict = 'BEARISH';
  else if (dailyBias === 'bull') verdict = 'BULLISH';
  else if (net >= 3) verdict = 'BULLISH (no daily bias)';
  else if (net <= -3) verdict = 'BEARISH (no daily bias)';
  else verdict = 'MIXED';

  const sortRows = (rows) => rows.sort((a, b) => b.weight - a.weight);

  return {
    symbol: facts.symbol,
    resolution: facts.resolution,
    capturedAt: snap.capturedAt,
    price: facts.price,
    verdict,
    dailyBias,
    bullScore,
    bearScore,
    net,
    gateFailures,
    bullish: sortRows(bullish),
    bearish: sortRows(bearish),
    facts
  };
}

module.exports = { score, extractFacts, num, side, pctFrom, DEADBAND_PCT, GATES, RULES };
