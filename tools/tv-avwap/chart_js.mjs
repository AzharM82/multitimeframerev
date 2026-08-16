/**
 * Page-context expressions evaluated inside the TradingView chart.
 *
 * Kept separate from publish_avwap.mjs so they can be exercised against a live
 * chart on their own (they are the part most likely to break when TradingView
 * changes their internal Electron structure).
 *
 * ── LEVELS ARE READ OFF THE CHART, NEVER RECOMPUTED ───────────────────────
 *
 * Earlier versions derived the moving averages from the bar series. That was
 * wrong twice, in ways invisible without comparing against the chart itself:
 *
 *   - we averaged `close` where the operator's studies average `ohlc4`
 *     (MXL 50 SMA: ours 75.1933, the chart's plotted line 75.1170)
 *   - we computed a 39m 21 EMA that is not plotted on his chart at all; his 21
 *     is a DAILY EMA from a higher-timeframe overlay
 *
 * The line the operator trades against is the plotted one, so that is the only
 * defensible source. Reading the plot removes source-series, period, smoothing
 * and timeframe mismatch in one move, and a study that is missing or
 * reconfigured becomes a loud preflight failure instead of a plausible number.
 *
 * ── The four levels ───────────────────────────────────────────────────────
 *
 *   avwap    "VWAP Auto Anchored", Anchor Period = Earnings   (chart timeframe)
 *   sma50    the standalone "Simple Moving Average", length 50 (chart timeframe)
 *   ema21d   EMA 21 on 1D, from "Moving Averages based on higher Timeframes"
 *   sma50d   SMA 50 on 1D, from the same higher-timeframe overlay
 *
 * The HTF overlay carries ten MA slots of eight inputs each
 * (`in_{8k}`=enabled, `in_{8k+2}`=type, `+3`=source, `+4`=length, `+5`=timeframe)
 * and plots slot k at `plot_{2k}`. Slots are located BY THEIR INPUTS, never by a
 * hardcoded index, so reordering or re-enabling slots cannot silently point us
 * at a different line - it fails to resolve instead.
 *
 * ── Chart model shape (verified 2026-08-16, TradingView 3.3.0 / web) ───────
 *   window._exposed_chartWidgetCollection.activeChartWidget.value()
 *     .model().model().dataSources()  -> every source on the chart
 *   any study    : data().valueAt(i) is [time, plot_0, plot_1, ...] in
 *                  metaInfo plot order, so plot_N sits at array index N+1
 *   price source : title() is "TICKER · EXCHANGE, RES" (has " · ", no "(")
 *                  data().bars().valueAt(i) is [time, o, h, l, c, volume]
 */

// Installs the sweep helpers. Idempotent - safe to re-evaluate.
export const INSTALL = `(function () {
  window.__avwSleep = (ms) => new Promise(r => setTimeout(r, ms));

  var T = function (s) { try { return s.title(); } catch (e) { return ''; } };

  window.__avwSources = function () {
    const cw = window._exposed_chartWidgetCollection.activeChartWidget.value();
    return cw.model().model().dataSources();
  };

  var inputsOf = function (s) {
    try {
      const iv = s.getInputValues ? s.getInputValues() : [];
      const map = {};
      for (const i of iv) map[String(i.id)] = i.value;
      return map;
    } catch (e) { return {}; }
  };

  /**
   * Resolve every level to {source, valueIdx}. valueIdx indexes the array from
   * data().valueAt(i), i.e. plot_N lives at index N+1.
   * Returns { levels, errors } - a missing level is an error, never a null.
   */
  window.__avwResolve = function () {
    const ds = window.__avwSources();
    const errors = [];
    const levels = {};

    const vw = ds.find(s => T(s).indexOf('VWAP AA') === 0);
    if (!vw) errors.push('VWAP AA study not on chart');
    else {
      const anchor = String(inputsOf(vw)['Anchor Period'] || '');
      if (!/^earnings$/i.test(anchor)) errors.push('VWAP AA anchor is "' + anchor + '", expected Earnings');
      else levels.avwap = { source: vw, valueIdx: 1, desc: 'VWAP AA (Earnings)' };
    }

    // Standalone SMA on the chart timeframe: title "SMA (50, ohlc4, ...)".
    // The HTF overlay is excluded - its title starts "Moving Averages".
    const sma = ds.find(s => /^SMA \\(/.test(T(s)));
    if (!sma) errors.push('standalone SMA study not on chart');
    else {
      const inp = inputsOf(sma);
      const len = Number(inp['Length'] !== undefined ? inp['Length'] : inp['in_0']);
      if (len !== 50) errors.push('standalone SMA length is ' + len + ', expected 50');
      else levels.sma50 = { source: sma, valueIdx: 1, desc: 'SMA 50 (chart TF)' };
    }

    // Higher-timeframe overlay: locate slots by their own inputs.
    const htf = ds.find(s => T(s).indexOf('Moving Averages HTF') === 0);
    if (!htf) errors.push('Moving Averages HTF study not on chart');
    else {
      const inp = inputsOf(htf);
      const findSlot = function (type, length, tf) {
        for (let k = 0; k < 10; k++) {
          const on = inp['in_' + (8 * k)];
          if (on !== true && on !== 'true') continue;
          if (String(inp['in_' + (8 * k + 2)]).toUpperCase() !== type) continue;
          if (Number(inp['in_' + (8 * k + 4)]) !== length) continue;
          if (String(inp['in_' + (8 * k + 5)]) !== tf) continue;
          return k;
        }
        return -1;
      };
      const k21 = findSlot('EMA', 21, '1D');
      if (k21 < 0) errors.push('no enabled EMA 21 1D slot in the HTF overlay');
      else levels.ema21d = { source: htf, valueIdx: 2 * k21 + 1, desc: 'EMA 21 (1D) slot ' + (k21 + 1) };
      const k50 = findSlot('SMA', 50, '1D');
      if (k50 < 0) errors.push('no enabled SMA 50 1D slot in the HTF overlay');
      else levels.sma50d = { source: htf, valueIdx: 2 * k50 + 1, desc: 'SMA 50 (1D) slot ' + (k50 + 1) };
    }

    return { levels: levels, errors: errors };
  };

  // Human-readable resolution report, for preflight and the inventory tool.
  window.__avwResolveReport = function () {
    const r = window.__avwResolve();
    const out = { errors: r.errors, levels: {} };
    for (const k of Object.keys(r.levels)) {
      const L = r.levels[k];
      let v = null, t = null;
      try { const d = L.source.data(); const a = d.valueAt(d.lastIndex()); t = a ? a[0] : null; v = a ? a[L.valueIdx] : null; } catch (e) {}
      out.levels[k] = { desc: L.desc, valueIdx: L.valueIdx, lastValue: v,
                        lastBar: t ? new Date(t * 1000).toISOString() : null };
    }
    return out;
  };

  var pctFrom = function (price, level) {
    if (typeof level !== 'number' || !isFinite(level) || level <= 0) return null;
    return +(((price - level) / level) * 100).toFixed(2);
  };

  /**
   * Reads only when the chart has fully settled on \`ticker\`, and only when every
   * level's series is on the SAME bar as the price series - for every bar used.
   * A half-recomputed study produced confidently wrong output in the MTF sidecar
   * work; never score across a partial recompute.
   *
   * Two different bars are reported, deliberately:
   *   LIVE   (index li) - what the tab shows. During RTH this bar is still
   *                       forming, so its close is really "price now".
   *   CLOSED (index ci) - what the ALERT is decided on, with its predecessor.
   *
   * The rule is "the candle CLOSES above the level and the previous candle was
   * below". A forming 39m bar can sit above a level for half an hour and settle
   * back under it, so scoring the live bar would fire alerts the closing print
   * never justified. \`ci\` is li once the last bar has actually elapsed, and
   * li-1 while it is still forming - so the session's final bar is still scored
   * when it closes rather than skipped until the next day.
   *
   * Deciding the cross from two adjacent BARS rather than two successive
   * publishes also makes the answer independent of how often this runs.
   */
  window.__avwRead = function (ticker, resSeconds) {
    const ds = window.__avwSources();
    const px = ds.find(s => T(s).indexOf(' \\u00b7 ') > -1 && T(s).indexOf('(') === -1);
    if (!px) return null;
    if (T(px).split(' \\u00b7 ')[0].trim() !== ticker) return null;

    const r = window.__avwResolve();
    if (r.errors.length) return { fatal: r.errors };

    let bars;
    try { bars = px.data().bars(); } catch (e) { return null; }
    const li = bars.lastIndex();
    if (!(li >= 2)) return null;
    const bLive = bars.valueAt(li);
    if (!bLive) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const lastBarClosed = nowSec >= bLive[0] + resSeconds;
    const ci = lastBarClosed ? li : li - 1;
    const pi = ci - 1;
    if (pi < 0) return null;

    const bC = bars.valueAt(ci), bP = bars.valueAt(pi);
    if (!bC || !bP) return null;
    const liveClose = bLive[4], cClose = bC[4], pClose = bP[4];
    if (typeof liveClose !== 'number' || typeof cClose !== 'number' || typeof pClose !== 'number') return null;

    const out = {
      ticker: ticker,
      time: bLive[0], close: liveClose,
      lastBarClosed: lastBarClosed,
      closedTime: bC[0], prevTime: bP[0],
      closedClose: cClose, prevClose: pClose,
      levels: {},
    };

    for (const key of ['avwap', 'sma50', 'ema21d', 'sma50d']) {
      const L = r.levels[key];
      if (!L) return { fatal: ['level ' + key + ' unresolved'] };
      let d;
      try { d = L.source.data(); } catch (e) { return null; }
      const lv = d.lastIndex();
      const aLive = d.valueAt(lv);
      const aC = d.valueAt(lv - (li - ci));
      const aP = d.valueAt(lv - (li - pi));
      if (!aLive || !aC || !aP) return null;
      if (aLive[0] !== bLive[0] || aC[0] !== bC[0] || aP[0] !== bP[0]) return null;
      const vLive = aLive[L.valueIdx], vC = aC[L.valueIdx], vP = aP[L.valueIdx];
      if (typeof vLive !== 'number' || !isFinite(vLive) || vLive <= 0) return null;
      const rec = { value: vLive, pct: pctFrom(liveClose, vLive),
                    cPct: pctFrom(cClose, vC), pPct: pctFrom(pClose, vP) };
      if (rec.pct === null || rec.cPct === null || rec.pPct === null) return null;
      out.levels[key] = rec;
    }

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
      if (r && r.fatal) return r;          // chart misconfigured - stop the sweep
      if (r) return r;
      await window.__avwSleep(250);
    }
    return null;
  };
  return 'ok';
})()`;

// Chart configuration read, so the publisher can fail closed on a wrong chart.
// Reports every level's resolution, so a missing or reconfigured study is a
// named failure rather than a plausible-looking number.
export function jsPreflight(expectRes) {
  return `(function () {
    const out = {};
    try {
      const c = window.TradingViewApi.activeChart();
      out.symbol = c.symbol();
      out.resolution = String(c.resolution());
      out.studies = c.getAllStudies().map(s => s.name);
      out.resolve = window.__avwResolveReport ? window.__avwResolveReport() : null;
    } catch (e) { out.err = String(e); }
    out.expectRes = ${JSON.stringify(expectRes)};
    return out;
  })()`;
}

// Resolve a watchlist BY NAME (never a hardcoded id - the operator rebuilds
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

// Sequential sweep. Symbols that never settle land in `failed` - a dead feed
// must never be indistinguishable from a quiet market. A `fatal` result aborts
// the sweep: that means the CHART is wrong, and every remaining symbol would be
// wrong the same way.
export function jsSweep(symbols, timeoutMs, resSeconds) {
  return `(async function () {
    const syms = ${JSON.stringify(symbols)};
    const rows = [], failed = [];
    for (const sym of syms) {
      let r = null;
      try { r = await window.__avwOne(sym, ${timeoutMs}, ${resSeconds}); } catch (e) { r = null; }
      if (r && r.fatal) return { rows: rows, failed: failed, fatal: r.fatal };
      if (r) rows.push(r); else failed.push(sym.split(':').pop());
    }
    return { rows: rows, failed: failed };
  })()`;
}

/**
 * Study/plot inventory for the bound chart.
 *
 * Dumps every study, its plot titles in metaInfo plot order, the value of each
 * plot on the last two bars, and its inputs - everything needed to wire or
 * re-verify a level without guessing indices.
 */
export const STUDY_INVENTORY = `(function () {
  const cw = window._exposed_chartWidgetCollection.activeChartWidget.value();
  const ds = cw.model().model().dataSources();
  const T = s => { try { return s.title(); } catch (e) { return ''; } };
  const out = [];
  for (const s of ds) {
    let title = T(s);
    if (!title || title.indexOf(' \\u00b7 ') > -1) continue;
    let meta = null;
    try { meta = s.metaInfo(); } catch (e) { continue; }
    if (!meta || !meta.styles) continue;
    const plots = (meta.plots || []).map(p => p.id);
    const styles = {};
    for (const k of Object.keys(meta.styles)) styles[k] = meta.styles[k].title;
    let last = null, prev = null, lastTime = null;
    try {
      const d = s.data(); const li = d.lastIndex();
      const v1 = d.valueAt(li), v0 = d.valueAt(li - 1);
      lastTime = v1 ? v1[0] : null;
      last = v1 ? v1.slice(1) : null;
      prev = v0 ? v0.slice(1) : null;
    } catch (e) {}
    let inputs = null;
    try {
      const iv = s.getInputValues ? s.getInputValues() : null;
      if (iv) inputs = iv.filter(i => /^in_\\d+$|Length|Anchor|source/i.test(String(i.id)))
                         .map(i => String(i.id) + '=' + String(i.value));
    } catch (e) {}
    out.push({ title, shortDesc: meta.shortDescription || '', plotOrder: plots,
               styles, lastTime, last, prev, inputs });
  }
  return out;
})()`;

export function jsRestoreSymbol(symbol) {
  return `(function(){ try { window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(symbol)}); return 'ok'; } catch(e) { return String(e); } })()`;
}
