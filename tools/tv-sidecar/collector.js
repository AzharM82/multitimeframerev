'use strict';

/**
 * Browser-side collector, evaluated in the TradingView Desktop page context
 * over CDP (Runtime.evaluate). Returns a JSON string.
 *
 * Read paths were verified live against TradingView Desktop 3.3.0.7992:
 *   - window.TradingViewApi.activeChart()                 -> chart widget API
 *   - chart.getAllStudies() / getStudyById(id)            -> study handles
 *   - study.study().dataWindowView().items()              -> named plot values
 *       (this is what the Data Window panel shows; richer than the study's
 *        plot array because zone/event plots are named too)
 *   - study.study().graphics().dwgtablecells()            -> Pine table.new cells
 *       Map('tableCells')._primitivesDataById -> Map<id, {tid,col,row,t}>
 *   - study.getInputsInfo() / getInputValues()            -> configured params
 *
 * Deliberately no MCP dependency: the sidecar talks CDP directly so it can run
 * headless under Task Scheduler.
 */

const COLLECT_JS = `(() => {
  const NOISE = /colou?r|transp|opacity|width|style|font|bg|background|display|visib/i;
  const EMPTY = new Set(['', 'n/a', '\\u2205', 'null', 'undefined']);

  function studyValues(inner) {
    const out = {};
    let dwv;
    try { dwv = inner.dataWindowView && inner.dataWindowView(); } catch (e) { return out; }
    if (!dwv || typeof dwv.items !== 'function') return out;
    let items;
    try { items = dwv.items() || []; } catch (e) { return out; }
    const seen = {};
    for (const it of items) {
      let title, value;
      try {
        title = String(typeof it.title === 'function' ? it.title() : it.title);
        value = String(typeof it.value === 'function' ? it.value() : it.value);
      } catch (e) { continue; }
      if (EMPTY.has(value.trim())) continue;      // skip disabled/unplotted series
      // Duplicate titles are real (PlotCandle x4, Plot x N) - suffix them.
      seen[title] = (seen[title] || 0) + 1;
      out[seen[title] === 1 ? title : title + '#' + seen[title]] = value;
    }
    return out;
  }

  function studyTables(inner) {
    const tables = [];
    let store;
    try {
      const g = inner.graphics && inner.graphics();
      if (!g || typeof g.dwgtablecells !== 'function') return tables;
      store = g.dwgtablecells().get('tableCells');
    } catch (e) { return tables; }
    if (!store || !store._primitivesDataById) return tables;
    const byTable = new Map();
    try {
      store._primitivesDataById.forEach((cell) => {
        if (!cell || cell.t === undefined) return;
        if (!byTable.has(cell.tid)) byTable.set(cell.tid, []);
        byTable.get(cell.tid).push(cell);
      });
    } catch (e) { return tables; }
    byTable.forEach((cells) => {
      const rows = new Map();
      for (const c of cells) {
        if (!rows.has(c.row)) rows.set(c.row, new Map());
        rows.get(c.row).set(c.col, String(c.t == null ? '' : c.t));
      }
      const ordered = [...rows.keys()].sort((a, b) => a - b).map((r) => {
        const cols = rows.get(r);
        return [...cols.keys()].sort((a, b) => a - b)
          .map((cc) => cols.get(cc)).filter((t) => t !== '');
      }).filter((cells2) => cells2.length > 0);
      if (ordered.length) tables.push(ordered);
    });
    return tables;
  }

  function studyInputs(st) {
    const out = {};
    try {
      const info = st.getInputsInfo() || [];
      const vals = st.getInputValues() || [];
      const byId = {};
      info.forEach((i) => { byId[i.id] = i.name || i.id; });
      const seen = {};
      for (const v of vals) {
        const k = String(byId[v.id] || v.id);
        if (NOISE.test(k)) continue;
        const t = typeof v.value;
        if (t !== 'number' && t !== 'boolean' && t !== 'string') continue;
        if (t === 'string' && v.value.length > 24) continue;
        seen[k] = (seen[k] || 0) + 1;
        out[seen[k] === 1 ? k : k + '#' + seen[k]] = v.value;
      }
    } catch (e) { /* inputs are best-effort */ }
    return out;
  }

  try {
    const c = window.TradingViewApi.activeChart();
    const studies = {};
    for (const s of c.getAllStudies()) {
      const rec = { values: {}, tables: [], inputs: {} };
      try {
        const st = c.getStudyById(s.id);
        const inner = (typeof st.study === 'function') ? st.study() : st.study;
        rec.values = studyValues(inner);
        rec.tables = studyTables(inner);
        rec.inputs = studyInputs(st);
        try { rec.error = st.hasError() || false; } catch (e) {}
      } catch (e) { rec.readError = String(e).slice(0, 120); }
      // Same indicator can legitimately be added twice.
      let name = s.name, n = 2;
      while (studies[name]) name = s.name + '#' + n++;
      studies[name] = rec;
    }
    return JSON.stringify({
      ok: true,
      symbol: c.symbol(),
      resolution: c.resolution(),
      capturedAt: Date.now(),
      studies
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e) });
  }
})()`;

module.exports = { COLLECT_JS };
