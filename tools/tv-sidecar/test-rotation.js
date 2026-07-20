'use strict';

/**
 * Ticker rotation soak test.
 *
 * Drives a list of tickers through analyze() in ONE process, the way the
 * sidecar does, to exercise repeated CDP attach/detach and symbol switching.
 * Reports per-ticker timing and failure, plus which tab got bound each time -
 * a tab that changes between rounds means binding is not stable.
 *
 * Run: node test-rotation.js [rounds]
 */

const { analyze, loadConfig } = require('./analyze.js');

const TICKERS = process.env.TICKERS
  ? process.env.TICKERS.split(',').map((s) => s.trim())
  : ['NSE:NIFTY', 'NBIS', 'AAPL', 'NSE:BANKNIFTY', 'SPY', 'VLO'];

const ROUNDS = Number(process.argv[2] || 1);

(async () => {
  const cfg = loadConfig();
  const results = [];

  for (let round = 1; round <= ROUNDS; round++) {
    for (const ticker of TICKERS) {
      const t0 = Date.now();
      try {
        const r = await analyze(ticker, cfg);
        const ms = Date.now() - t0;
        results.push({ round, ticker, ok: true, ms, resolved: r.symbol, verdict: r.verdict, tab: r.meta.chartId, studies: `${r.meta.studiesPopulated}/${r.meta.totalStudies}` });
        console.log(`  OK   ${String(ticker).padEnd(14)} ${String(ms + 'ms').padEnd(8)} ${r.symbol.padEnd(16)} ${r.verdict.padEnd(22)} ${r.meta.studiesPopulated}/${r.meta.totalStudies} studies`);
      } catch (e) {
        const ms = Date.now() - t0;
        results.push({ round, ticker, ok: false, ms, error: e.message });
        console.log(`  FAIL ${String(ticker).padEnd(14)} ${String(ms + 'ms').padEnd(8)} ${e.message}`);
      }
    }
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const times = ok.map((r) => r.ms);

  console.log('\n================ SUMMARY ================');
  console.log(`attempts : ${results.length}`);
  console.log(`succeeded: ${ok.length}`);
  console.log(`failed   : ${bad.length}`);
  if (times.length) {
    times.sort((a, b) => a - b);
    console.log(`timing   : min ${times[0]}ms | median ${times[Math.floor(times.length / 2)]}ms | max ${times[times.length - 1]}ms`);
  }
  const tabs = [...new Set(ok.map((r) => r.tab))];
  console.log(`tabs used: ${tabs.join(', ')}${tabs.length > 1 ? '  <-- UNSTABLE BINDING' : '  (stable)'}`);
  if (bad.length) {
    console.log('\nfailures:');
    for (const b of bad) console.log(`  ${b.ticker}: ${b.error}`);
  }
  process.exit(bad.length ? 1 : 0);
})();
