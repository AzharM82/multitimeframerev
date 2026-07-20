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
 * Env:
 *   PORTAL_BASE   default https://salmon-river-0a7a0c30f.1.azurestaticapps.net
 *   TIMER_SECRET  required - shared secret for POST /api/tv-analysis
 *   POLL_MS       default 3000
 */

const { analyze, loadConfig } = require('./analyze.js');

const PORTAL_BASE = (process.env.PORTAL_BASE || 'https://salmon-river-0a7a0c30f.1.azurestaticapps.net').replace(/\/$/, '');
const TIMER_SECRET = process.env.TIMER_SECRET || '';
const POLL_MS = Number(process.env.POLL_MS || 3000);

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

  let lastRequestId = null;

  for (;;) {
    try {
      const req = await fetchRequest();
      if (req && req.ticker && req.requestId && req.requestId !== lastRequestId) {
        // Claim it before the work starts, so a failure cannot spin the loop
        // re-analysing the same request forever.
        lastRequestId = req.requestId;
        log(`request ${req.requestId} -> ${req.ticker}`);

        try {
          const result = await analyze(req.ticker, cfg);
          await publish(toPayload(result, req.requestId));
          log(`published ${result.symbol}: ${result.verdict} (bull ${result.bullScore} / bear ${result.bearScore})`);
        } catch (e) {
          // Publish the failure too - otherwise the portal polls until timeout
          // and the user has no idea what went wrong.
          log(`ANALYSE FAILED: ${e.message}`);
          await publish({
            requestId: req.requestId,
            symbol: req.ticker,
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
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
