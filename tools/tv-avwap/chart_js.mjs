/**
 * Page-context expressions evaluated inside the TradingView chart.
 *
 * Kept separate from publish_avwap.mjs so they can be exercised against a live
 * chart on their own (they are the part most likely to break when TradingView
 * changes their internal Electron structure).
 *
 * Chart model shape (verified 2026-08-15 against TradingView 3.3.0 / web):
 *   window._exposed_chartWidgetCollection.activeChartWidget.value()
 *     .model().model().dataSources()  -> every source on the chart
 *   study source  : title() starts "VWAP AA"; data().valueAt(i) is
 *                   [time, plot_0..plot_n] in metaInfo plot order, where
 *                   plot_0 = VWAP and plot_1/2 = upper/lower band #1
 *                   (confirmed arithmetically: band = VWAP x 1.01 / 0.99 at
 *                   Percentage mode, multiplier 1)
 *   price source  : title() is "TICKER · EXCHANGE, RES" (has " · ", no "(")
 *                   data().bars().valueAt(i) is [time, o, h, l, c, volume]
 *
 * WHY THE EMAs ARE COMPUTED HERE rather than read off a study: the operator's
 * 39m layout carries daily higher-timeframe MAs and a 195-period SMA, not a 39m
 * EMA 21/50. Adding studies to the shared chart would make the sweep depend on
 * chart configuration that other tools also touch. The bar series is right
 * there, so we derive the EMAs from it — deterministic, and it cannot silently
 * read the wrong study's plot.
 */

// Installs the sweep helpers. Idempotent — safe to re-evaluate.
export const INSTALL = `(function () {
  window.__avwSleep = (ms) => new Promise(r => setTimeout(r, ms));

  window.__avwSrcs = function () {
    const cw = window._exposed_chartWidgetCollection.activeChartWidget.value();
    const ds = cw.model().model().dataSources();
    const T = s => { try { return s.title(); } catch (e) { return ''; } };
    return {
      vw: ds.find(s => T(s).indexOf('VWAP AA') === 0),
      px: ds.find(s => T(s).indexOf(' \\u00b7 ') > -1 && T(s).indexOf('(') === -1),
      T,
    };
  };

  // Standard EMA over an array of closes; returns the FULL series so the caller
  // can take both the last and the previous bar from one pass. Seeded with an
  // SMA of the first \`period\` values, which is what TradingView does.
  window.__avwEma = function (closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    let prev = sum / period;
    const out = new Array(closes.length).fill(null);
    out[period - 1] = prev;
    for (let i = period; i < closes.length; i++) {
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };

  // Simple moving average over the same closes. The operator's chart draws a
  // 50 SMA (not an EMA) alongside the 21 EMA, and an SMA50 and an EMA50 sit at
  // materially different prices -- alerting on the EMA would fire at a level
  // that is not on his chart.
  window.__avwSma = function (closes, period) {
    if (closes.length < period) return null;
    const out = new Array(closes.length).fill(null);
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= period) sum -= closes[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  };

  var pctFrom = function (price, level) {
    if (typeof level !== 'number' || !isFinite(level) || level <= 0) return null;
    return +(((price - level) / level) * 100).toFixed(2);
  };

  // Reads only when the chart has fully settled on \`ticker\`: the price source
  // must be that symbol AND the study's last bar must be the SAME bar as the
  // price series. A half-recomputed study produced confidently wrong output in
  // the MTF sidecar work — never score across a partial recompute.
  //
  // Two different bars are reported, deliberately:
  //
  //   LIVE  (index li)     — what the tab shows. During RTH this bar is still
  //                          forming, so its close is really "price now".
  //   CLOSED (index ci)    — what the ALERT is decided on, with its predecessor.
  //
  // The operator's rule is "the candle CLOSES above X and the previous candle
  // was below". A forming bar can sit above a level for 30 minutes and settle
  // back under it, so scoring the live bar would fire alerts that the closing
  // print never justified. \`ci\` is li when the last bar has actually elapsed
  // (after hours, and for the first minutes after each bar boundary) and li-1
  // while a bar is still forming — so the final bar of the session is still
  // scored once it closes, instead of being skipped until the next day.
  //
  // Deciding the cross from two adjacent BARS rather than two successive
  // publishes also makes the answer independent of how often this runs.
  window.__avwRead = function (ticker, resSeconds) {
    const { vw, px, T } = window.__avwSrcs();
    if (!vw || !px) return null;
    if (T(px).split(' \\u00b7 ')[0].trim() !== ticker) return null;

    let bars, vwd;
    try { bars = px.data().bars(); } catch (e) { return null; }
    try { vwd = vw.data(); } catch (e) { return null; }
    const li = bars.lastIndex(), lv = vwd.lastIndex();
    if (!(li >= 2)) return null;

    const bLive = bars.valueAt(li);
    const vLive = vwd.valueAt(lv);
    if (!bLive || !vLive || bLive[0] !== vLive[0]) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const lastBarClosed = nowSec >= bLive[0] + resSeconds;
    const ci = lastBarClosed ? li : li - 1;      // last CLOSED bar
    const pi = ci - 1;                            // the one before it
    if (pi < 0) return null;
    const vci = lv - (li - ci), vpi = vci - 1;
    if (vpi < 0) return null;

    const bC = bars.valueAt(ci), bP = bars.valueAt(pi);
    const vC = vwd.valueAt(vci), vP = vwd.valueAt(vpi);
    if (!bC || !bP || !vC || !vP) return null;
    if (bC[0] !== vC[0] || bP[0] !== vP[0]) return null;

    const closes = [];
    for (let i = 0; i <= li; i++) {
      const b = bars.valueAt(i);
      closes.push(b && typeof b[4] === 'number' ? b[4] : NaN);
    }
    if (closes.some(isNaN)) return null;

    const e21 = window.__avwEma(closes, 21);
    const s50 = window.__avwSma(closes, 50);
    const at = (arr, i) => (arr && typeof arr[i] === 'number' ? arr[i] : null);

    const liveClose = closes[li], cClose = closes[ci], pClose = closes[pi];
    const liveAvwap = vLive[1], cAvwap = vC[1], pAvwap = vP[1];
    if (typeof liveAvwap !== 'number' || !isFinite(liveAvwap) || liveAvwap <= 0) return null;
    if (typeof cAvwap !== 'number' || typeof pAvwap !== 'number') return null;

    const out = {
      ticker: ticker,
      // live (display)
      time: bLive[0], close: liveClose,
      avwap: liveAvwap, ema21: at(e21, li), sma50: at(s50, li),
      pctAvwap: pctFrom(liveClose, liveAvwap),
      pctEma21: pctFrom(liveClose, at(e21, li)),
      pctSma50: pctFrom(liveClose, at(s50, li)),
      // closed (alerting)
      lastBarClosed: lastBarClosed,
      closedTime: bC[0], prevTime: bP[0],
      closedClose: cClose, prevClose: pClose,
      cPctAvwap: pctFrom(cClose, cAvwap), pPctAvwap: pctFrom(pClose, pAvwap),
      cPctEma21: pctFrom(cClose, at(e21, ci)), pPctEma21: pctFrom(pClose, at(e21, pi)),
      cPctSma50: pctFrom(cClose, at(s50, ci)), pPctSma50: pctFrom(pClose, at(s50, pi)),
      bars: closes.length,
    };
    if (out.pctAvwap === null || out.cPctAvwap === null || out.pPctAvwap === null) return null;
    return out;
  };

  window.__avwOne = async function (sym, timeoutMs, resSeconds) {
    const ticker = sym.split(':').pop();
    const chart = window.TradingViewApi.activeChart();
    await new Promise(res => {
      try { chart.setSymbol(sym, res); } catch (e) { res(); }
      setTimeout(res, 4000);
    });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = window.__avwRead(ticker, resSeconds);
      if (r) return r;
      await window.__avwSleep(250);
    }
    return null;
  };
  return 'ok';
})()`;

// Chart configuration read, so the publisher can fail closed on a wrong chart.
export function jsPreflight(expectRes) {
  return `(function () {
    const out = {};
    try {
      const c = window.TradingViewApi.activeChart();
      out.symbol = c.symbol();
      out.resolution = String(c.resolution());
      const studies = c.getAllStudies();
      out.studies = studies.map(s => s.name);
      const vw = studies.find(s => /VWAP Auto Anchored/i.test(s.name));
      if (vw) {
        const inputs = c.getStudyById(vw.id).getInputValues();
        const anchor = inputs.find(i => String(i.id).toLowerCase().indexOf('anchor') === 0);
        out.anchor = anchor ? String(anchor.value) : '';
        out.source = (inputs.find(i => i.id === 'source') || {}).value || '';
      }
    } catch (e) { out.err = String(e); }
    out.expectRes = ${JSON.stringify(expectRes)};
    return out;
  })()`;
}

// Resolve a watchlist BY NAME (never a hardcoded id — the operator rebuilds
// these) and return its symbols.
export function jsWatchlist(name) {
  return `(async function () {
    const all = await fetch('/api/v1/symbols_list/all/', { credentials: 'include' }).then(r => r.json());
    const wl = Array.isArray(all)
      ? all.find(w => String(w.name || '').toUpperCase() === ${JSON.stringify(name)}.toUpperCase())
      : null;
    if (!wl) return { error: 'watchlist_not_found', names: (all || []).map(w => w.name) };
    const full = await fetch('/api/v1/symbols_list/custom/' + wl.id + '/', { credentials: 'include' })
      .then(r => r.json());
    return { id: wl.id, name: wl.name, symbols: (full.symbols || []).filter(s => typeof s === 'string') };
  })()`;
}

// Sequential sweep. Symbols that never settle land in `failed` — a dead feed
// must never be indistinguishable from a quiet market.
export function jsSweep(symbols, timeoutMs, resSeconds) {
  return `(async function () {
    const syms = ${JSON.stringify(symbols)};
    const rows = [], failed = [];
    for (const sym of syms) {
      let r = null;
      try { r = await window.__avwOne(sym, ${timeoutMs}, ${resSeconds}); } catch (e) { r = null; }
      if (r) rows.push(r); else failed.push(sym.split(':').pop());
    }
    return { rows, failed };
  })()`;
}

// Self-check: verify the MA implementations against a known series.
export const EMA_SELFTEST = `(function () {
  const closes = [];
  for (let i = 1; i <= 60; i++) closes.push(i);
  const e = window.__avwEma(closes, 21);
  // On a linear ramp with step 1, EMA converges to (last - (period-1)/2).
  return { last: e[59], expectApprox: 60 - 10, seeded: e[20], nullBefore: e[19] };
})()`;

export function jsRestoreSymbol(symbol) {
  return `(function(){ try { window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(symbol)}); return 'ok'; } catch(e) { return String(e); } })()`;
}
