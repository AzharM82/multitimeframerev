'use strict';

/**
 * Browser-side historical collector.
 *
 * Rebuilds a per-bar snapshot for the last N bars from the chart's own series,
 * so the day's trend can be recomputed on demand rather than stored.
 *
 * Read path (verified live against TradingView Desktop 3.3.0.7992):
 *   study.study().metaInfo().plots   -> ordered plot descriptors
 *   study.study().metaInfo().styles  -> { plot_N: { title } } display names
 *   study.study().data().valueAt(i)  -> [barTime, plot0, plot1, ...]
 *
 * Two details that matter:
 *
 * 1. value[0] is the bar time; value[i+1] corresponds to plots[i]. Only
 *    type === 'line' plots carry numbers - 'colorer' plots hold colour indices
 *    and must be skipped or they pollute the fact set with integers that look
 *    like prices.
 *
 * 2. Higher-timeframe studies (the 1D moving averages) emit a value only when
 *    THEIR bar closes, so intraday rows are null. Those nulls are forward
 *    filled: a daily EMA genuinely does not move during the session, so
 *    carrying the last known value is correct rather than a convenience.
 *
 * Pine TABLE values (Swing Data, Saty Volume Stack) are deliberately absent -
 * tables have no history. Bars produced here are scored structural-only.
 */

const COLLECT_HISTORY_JS = (bars) => `(() => {
  const BARS = ${Number(bars)};
  try {
    const c = window.TradingViewApi.activeChart();
    const studies = {};

    for (const s of c.getAllStudies()) {
      let inner;
      try {
        const st = c.getStudyById(s.id);
        inner = (typeof st.study === 'function') ? st.study() : st.study;
      } catch (e) { continue; }

      let mi, d, lastIndex;
      try {
        mi = inner.metaInfo();
        d = inner.data();
        lastIndex = d.lastIndex();
      } catch (e) { continue; }
      if (mi == null || d == null || lastIndex == null) continue;

      const plots = mi.plots || [];
      const stylesMeta = mi.styles || {};

      // value index -> display name, line plots only, duplicates suffixed to
      // match the live collector's naming.
      const nameAt = {};
      const seen = {};
      plots.forEach((p, i) => {
        if (!p || p.type !== 'line') return;
        const title = (stylesMeta[p.id] || {}).title;
        if (!title) return;
        seen[title] = (seen[title] || 0) + 1;
        nameAt[i + 1] = seen[title] === 1 ? title : title + '#' + seen[title];
      });
      if (!Object.keys(nameAt).length) continue;

      // Oldest -> newest so forward fill runs in the right direction.
      const start = Math.max(0, lastIndex - BARS + 1);
      const carried = {};
      const series = [];
      for (let i = start; i <= lastIndex; i++) {
        let row;
        try { row = d.valueAt(i); } catch (e) { row = null; }
        if (!row || !row.length) continue;
        const values = {};
        for (const k in nameAt) {
          const v = row[k];
          if (v !== null && v !== undefined && typeof v === 'number' && isFinite(v)) {
            carried[nameAt[k]] = v;
          }
          if (carried[nameAt[k]] !== undefined) values[nameAt[k]] = carried[nameAt[k]];
        }
        series.push({ t: row[0], values: values });
      }
      if (series.length) studies[s.name] = series;
    }

    return JSON.stringify({
      ok: true,
      symbol: c.symbol(),
      resolution: c.resolution(),
      studies: studies
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e) });
  }
})()`;

/**
 * Pivot the per-study series into one snapshot per bar, shaped exactly like the
 * live collector's output so the same scoring code consumes both.
 *
 * Bars are keyed by bar time; a study missing that bar simply contributes no
 * values, and the rubric's null checks skip the affected rules.
 */
function toBarSnapshots(raw) {
  if (!raw || !raw.ok) return [];
  const byTime = new Map();

  for (const [studyName, series] of Object.entries(raw.studies || {})) {
    for (const point of series) {
      if (!point || point.t == null) continue;
      if (!byTime.has(point.t)) byTime.set(point.t, {});
      byTime.get(point.t)[studyName] = { values: point.values || {}, tables: [] };
    }
  }

  return [...byTime.keys()]
    .sort((a, b) => a - b)
    .map((t) => ({
      ok: true,
      symbol: raw.symbol,
      resolution: raw.resolution,
      capturedAt: t * 1000, // chart bar times are epoch SECONDS
      barTime: t,
      studies: byTime.get(t),
    }));
}

module.exports = { COLLECT_HISTORY_JS, toBarSnapshots };
