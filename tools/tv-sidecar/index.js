'use strict';

/**
 * TradingView sidecar loop.
 *
 * Runs on the trading desktop (Task Scheduler at logon). Polls the portal for a
 * ticker request, drives TradingView Desktop over CDP, scores the chart, and
 * publishes the result back. The portal cannot reach this machine, so every
 * exchange is outbound.
 *
 *   node index.js
 *
 * Once a ticker is requested it stays live: the sidecar keeps re-reading it on
 * a timer and republishing, so the portal shows a rolling grade, until a
 * different ticker is requested.
 *
 * Env:
 *   PORTAL_BASE   default https://salmon-river-0a7a0c30f.1.azurestaticapps.net
 *   TIMER_SECRET  required - shared secret for POST /api/tv-analysis
 *   POLL_MS       default 3000   (how often to check for a NEW ticker)
 *   REFRESH_MS    default 600000 (how often to re-read the CURRENT ticker)
 */

const { analyze, loadConfig } = require('./analyze.js');

const PORTAL_BASE = (process.env.PORTAL_BASE || 'https://salmon-river-0a7a0c30f.1.azurestaticapps.net').replace(/\/$/, '');
const TIMER_SECRET = process.env.TIMER_SECRET || '';
const POLL_MS = Number(process.env.POLL_MS || 3000);

/**
 * How often to re-read the ticker that is currently being watched. Defaults to
 * the chart's own timeframe (10 minutes), because that is the rate at which the
 * underlying bar - and therefore most of the rubric - can actually change.
 */
const REFRESH_MS = Number(process.env.REFRESH_MS || 600_000);

/**
 * Settle time after a bar boundary before reading. The bar closes on the wall
 * clock but the chart needs a moment to roll it over and recompute studies.
 */
const BAR_SETTLE_MS = Number(process.env.BAR_SETTLE_MS || 15_000);

/** Align refreshes to wall-clock bar boundaries rather than "N ms since last". */
const ALIGN_TO_BAR = process.env.ALIGN_TO_BAR !== 'false';

/**
 * Next wall-clock bar boundary + settle time.
 *
 * A fixed interval from the last read drifts: read at 09:37 and every
 * subsequent reading lands mid-bar. Aligning to the boundary means each refresh
 * happens just after a bar completes, so consecutive readings are comparable
 * and each one covers a whole bar.
 */
function nextBarDue(now = Date.now()) {
  if (!ALIGN_TO_BAR) return now + REFRESH_MS;
  const boundary = Math.ceil((now + 1) / REFRESH_MS) * REFRESH_MS;
  return boundary + BAR_SETTLE_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function fetchRequest() {
  const res = await fetch(`${PORTAL_BASE}/api/tv-request`, {
    headers: { accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`GET /api/tv-request -> ${res.status}`);
  return res.json();
}

async function publish(payload) {
  const res = await fetch(`${PORTAL_BASE}/api/tv-analysis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-timer-secret': TIMER_SECRET },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST /api/tv-analysis -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Strip the raw snapshot; the portal only needs the scored rows. */
function toPayload(result, requestId) {
  return {
    requestId,
    symbol: result.symbol,
    resolution: result.resolution,
    price: result.price,
    verdict: result.verdict,
    dailyBias: result.dailyBias,
    bullScore: result.bullScore,
    bearScore: result.bearScore,
    net: result.net,
    gateFailures: result.gateFailures,
    bullish: result.bullish.map((r) => ({ weight: r.weight, signal: r.signal, detail: r.detail })),
    bearish: result.bearish.map((r) => ({ weight: r.weight, signal: r.signal, detail: r.detail })),
    meta: result.meta
  };
}

async function main() {
  if (!TIMER_SECRET) {
    console.error('TIMER_SECRET is not set - the portal will reject every publish. Refusing to start.');
    process.exit(2);
  }
  const cfg = loadConfig();
  log(`sidecar up | portal ${PORTAL_BASE} | poll ${POLL_MS}ms | chartId ${cfg.chartId ?? '(auto-detect)'}`);

  // The ticker currently being watched. Survives until a DIFFERENT one is
  // requested, so the portal gets a rolling grade rather than a single reading.
  let watching = null; // { ticker, requestId }
  let nextDueAt = 0;

  async function runOnce(ticker, requestId, reason) {
    log(`${reason} -> ${ticker}`);
    // Schedule from the boundary, not from when this run finishes, so a slow
    // read cannot push every later refresh off the bar grid.
    nextDueAt = nextBarDue();
    try {
      const result = await analyze(ticker, cfg);
      await publish(toPayload(result, requestId));
      log(`published ${result.symbol}: ${result.verdict} (bull ${result.bullScore} / bear ${result.bearScore})`);
    } catch (e) {
      // Publish the failure too - otherwise the portal polls until timeout and
      // the user has no idea what went wrong.
      log(`ANALYSE FAILED: ${e.message}`);
      await publish({
        requestId,
        symbol: ticker,
        verdict: 'ERROR',
        error: e.message,
        price: null,
        dailyBias: null,
        bullScore: 0,
        bearScore: 0,
        net: 0,
        gateFailures: [],
        bullish: [],
        bearish: []
      }).catch((pe) => log(`could not publish error: ${pe.message}`));
    }
  }

  for (;;) {
    try {
      const req = await fetchRequest();

      // A new requestId means the user submitted again - even for the same
      // ticker, which is how "Refresh" asks for an immediate re-read.
      const isNew = req && req.ticker && req.requestId &&
                    (!watching || req.requestId !== watching.requestId);

      if (isNew) {
        // Claim it before the work starts, so a failure cannot spin the loop
        // re-analysing the same request forever.
        watching = { ticker: req.ticker, requestId: req.requestId };
        await runOnce(watching.ticker, watching.requestId, `request ${req.requestId}`);
        log(`next refresh at ${new Date(nextDueAt).toISOString()}`);
      } else if (watching && Date.now() >= nextDueAt) {
        // Republished under the ORIGINAL requestId: this is the same watch,
        // refreshed. The portal distinguishes updates by computedAt.
        await runOnce(watching.ticker, watching.requestId, 'refresh (bar close)');
      }
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
