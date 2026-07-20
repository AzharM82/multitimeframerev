'use strict';

/**
 * Drive TradingView Desktop over CDP and produce a scored analysis.
 *
 * CLI:  node analyze.js NSE:NIFTY            # analyse one ticker, print report
 *       node analyze.js NSE:NIFTY --json     # machine-readable
 *
 * Binds to ONE chart tab and never touches the others. The tab is chosen by
 * chart id from config; the app blocks programmatic tab creation, so the tab
 * must already exist (see cdp.js header).
 */

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');
const { COLLECT_JS } = require('./collector.js');
const { score } = require('./rules.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/**
 * Studies whose values the rubric's weight-3 rules depend on. If any of these
 * is still recomputing after a symbol change, the reading is worthless.
 *
 * Learned the hard way: a run that accepted 11 of 12 studies scored live price
 * against a HALF-RECOMPUTED Saty level set (Upper Trigger 24,130 instead of
 * 24,393) and emitted a confident 21-0 bullish sweep on NSE:NIFTY. Nothing in
 * the output looked wrong. A count-based threshold is not enough - the
 * specific studies must be present, and the reading must be stable.
 */
const CRITICAL_STUDIES = [
  /Saty ATR Levels/i,
  /higher Timeframes/i,
  /Pivot Ribbon/i,
  /TheVWAP/i
];

function loadConfig() {
  const defaults = {
    port: cdp.DEFAULT_PORT,
    chartId: null,          // null = use the first chart tab
    intradayResolution: '10',
    dailyResolution: 'D',
    autoLaunch: true,
    // Off by default: relaunching kills a TradingView the user may be trading on.
    relaunchIfNoCdp: false
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return defaults;
  }
}

/**
 * Make sure TradingView is up AND reachable over CDP.
 *
 * Three distinct states, and conflating them is what breaks things:
 *   1. CDP reachable            -> use it
 *   2. not running at all       -> launch with the flag (fully automatic)
 *   3. running WITHOUT the flag -> cannot be attached to, ever. Launching
 *      again does not help: a second AppX activation just focuses the existing
 *      window, so CDP never appears and we would block for the full timeout.
 *      Relaunching means killing the user's live TradingView, so it is opt-in
 *      (config.relaunchIfNoCdp) rather than a silent default.
 */
async function ensureRunning(cfg) {
  if (await cdp.isUp(cfg.port)) return 'already-running';

  if (!cfg.autoLaunch) {
    throw new Error(`TradingView not reachable on port ${cfg.port} and autoLaunch is off`);
  }

  if (await cdp.isProcessRunning()) {
    if (!cfg.relaunchIfNoCdp) {
      throw new Error(
        'TradingView is running but was started WITHOUT the CDP flag, which cannot be ' +
        'applied to a live process. Close it and reopen with tools\\tv-launch.ps1 ' +
        '(or set "relaunchIfNoCdp": true in config.json to let the sidecar restart it ' +
        'automatically — note that closes your open TradingView).'
      );
    }
    await cdp.killAll();
    await cdp.launch(cfg.port);
    return 'relaunched';
  }

  await cdp.launch(cfg.port);
  return 'launched';
}

/** Does this target carry the full indicator template we score against? */
async function targetHasTemplate(target) {
  let sess;
  try {
    sess = await new cdp.Session(target.webSocketDebuggerUrl).connect();
    const names = await sess.evaluate(
      `JSON.stringify(window.TradingViewApi.activeChart().getAllStudies().map(s => s.name))`
    );
    const list = JSON.parse(names || '[]');
    return CRITICAL_STUDIES.every((re) => list.some((n) => re.test(n)));
  } catch {
    return false;
  } finally {
    if (sess) sess.close();
  }
}

/**
 * Pick the tab to drive.
 *
 * Binding by list order is unsafe: /json/list ordering is not stable, and two
 * targets can share one chart id (observed: SJYkgXd7 appears twice, one on
 * NIFTY and one on SPY). Binding wrongly would flip a chart the user is
 * actively trading, so candidates are probed for the indicator template and
 * anything ambiguous is a hard error rather than a guess.
 */
async function bindTab(cfg) {
  const targets = await cdp.listChartTargets(cfg.port);
  if (!targets.length) throw new Error('No TradingView chart tabs found');

  let candidates = targets;
  if (cfg.chartId) {
    candidates = targets.filter((t) => cdp.chartIdOf(t) === cfg.chartId);
    if (!candidates.length) {
      const ids = [...new Set(targets.map((t) => cdp.chartIdOf(t)))].join(', ');
      throw new Error(`Bound chart "${cfg.chartId}" is not open. Available: ${ids}`);
    }
  }

  const matches = [];
  for (const t of candidates) {
    if (await targetHasTemplate(t)) matches.push(t);
  }

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No chart tab carries the full indicator template ` +
      `(${CRITICAL_STUDIES.map((r) => r.source).join(', ')}). ` +
      `Load the template onto the tab you want analysed.`
    );
  }
  throw new Error(
    `${matches.length} tabs carry the indicator template ` +
    `(${matches.map((t) => cdp.chartIdOf(t)).join(', ')}). ` +
    `Set "chartId" in config.json to pick one.`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the chart reports the symbol/resolution we asked for AND enough
 * studies have recomputed. Symbol changes are async: reading too early yields
 * the PREVIOUS ticker's values under the new ticker's name, which is worse
 * than an error because it looks like valid data.
 */
function populatedCount(snap) {
  return Object.values(snap.studies).filter(
    (s) => Object.keys(s.values || {}).length > 0 || (s.tables || []).length > 0
  ).length;
}

/** Which critical studies are still missing values. */
function missingCritical(snap) {
  const names = Object.keys(snap.studies);
  return CRITICAL_STUDIES
    .filter((re) => {
      const key = names.find((n) => re.test(n));
      if (!key) return true; // not on the chart at all
      const s = snap.studies[key];
      return Object.keys(s.values || {}).length === 0 && (s.tables || []).length === 0;
    })
    .map((re) => re.source);
}

/**
 * The anchor that proves the level set finished recomputing. Saty's Previous
 * Close is fixed for the session, so if two consecutive reads agree on it the
 * study has settled - whereas price legitimately changes tick to tick and
 * cannot be used for a stability check on a live market.
 */
function satyAnchor(snap) {
  const key = Object.keys(snap.studies).find((n) => /Saty ATR Levels/i.test(n));
  if (!key) return null;
  const v = snap.studies[key].values || {};
  return `${v['Previous Close'] ?? '?'}|${v['Upper Trigger'] ?? '?'}|${v['Lower Trigger'] ?? '?'}`;
}

async function waitForChart(sess, wantSymbol, wantRes, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let prevAnchor = null;

  while (Date.now() < deadline) {
    const raw = await sess.evaluate(COLLECT_JS);
    let snap;
    try { snap = JSON.parse(raw); } catch { snap = null; }

    if (snap && snap.ok) {
      const symOk = !wantSymbol || snap.symbol.toUpperCase().includes(wantSymbol.split(':').pop().toUpperCase());
      const resOk = !wantRes || String(snap.resolution) === String(wantRes);
      const missing = missingCritical(snap);
      const total = Object.keys(snap.studies).length;
      const populated = populatedCount(snap);
      const anchor = satyAnchor(snap);

      // Every study populated, every critical study present, and the level set
      // identical to the previous poll. All three, or we keep waiting.
      if (symOk && resOk && !missing.length && populated === total && anchor && anchor === prevAnchor) {
        return snap;
      }
      prevAnchor = anchor;
      last = { symbol: snap.symbol, resolution: snap.resolution, populated, total, missing };
    }
    await sleep(1000);
  }

  throw new Error(
    `chart did not settle on ${wantSymbol} @ ${wantRes} within ${timeoutMs}ms` +
    (last
      ? ` (last: ${last.symbol} @ ${last.resolution}, ${last.populated}/${last.total} populated` +
        (last.missing.length ? `, missing critical: ${last.missing.join(', ')}` : '') + ')'
      : '')
  );
}

async function analyze(ticker, cfg = loadConfig()) {
  const launchState = await ensureRunning(cfg);
  const target = await bindTab(cfg);
  const sess = await new cdp.Session(target.webSocketDebuggerUrl).connect();
  try {
    // Set symbol first, then resolution; both are async on the chart model.
    await sess.evaluate(
      `window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(ticker)})`
    );
    await sess.evaluate(
      `window.TradingViewApi.activeChart().setResolution(${JSON.stringify(cfg.intradayResolution)})`
    );
    const snap = await waitForChart(sess, ticker, cfg.intradayResolution);

    const result = score(snap);
    result.meta = {
      launchState,
      chartId: cdp.chartIdOf(target),
      studiesPopulated: populatedCount(snap),
      totalStudies: Object.keys(snap.studies).length
    };
    result.snapshot = snap;
    return result;
  } finally {
    sess.close();
  }
}

module.exports = { analyze, loadConfig, bindTab, ensureRunning };

if (require.main === module) {
  const ticker = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!ticker) {
    console.error('usage: node analyze.js <TICKER> [--json]');
    process.exit(2);
  }
  analyze(ticker)
    .then((r) => {
      if (asJson) {
        const { snapshot, ...rest } = r;
        console.log(JSON.stringify(rest, null, 2));
        return;
      }
      const pad = (s, n) => String(s).padEnd(n);
      console.log(`\n=== ${r.symbol} @ ${r.price} (${r.resolution}m) ===`);
      console.log(`VERDICT: ${r.verdict}`);
      console.log(`daily bias: ${r.dailyBias ?? 'none'}   bull ${r.bullScore} / bear ${r.bearScore}   net ${r.net > 0 ? '+' : ''}${r.net}`);
      console.log(`tab ${r.meta.chartId} | ${r.meta.studiesPopulated}/${r.meta.totalStudies} studies | TV ${r.meta.launchState}`);
      if (r.gateFailures.length) console.log(`GATE FAILURES: ${r.gateFailures.join('; ')}`);
      console.log('\nBULLISH');
      if (!r.bullish.length) console.log('  (none)');
      for (const x of r.bullish) console.log(`  [${x.weight}] ${pad(x.signal, 34)} ${x.detail}`);
      console.log('\nBEARISH');
      if (!r.bearish.length) console.log('  (none)');
      for (const x of r.bearish) console.log(`  [${x.weight}] ${pad(x.signal, 34)} ${x.detail}`);
      console.log('');
    })
    .catch((e) => { console.error('ANALYZE FAILED:', e.message); process.exit(1); });
}
