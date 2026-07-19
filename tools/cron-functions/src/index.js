/* eslint-disable no-console */
/**
 * Cron timers for the MTF Reversal v2 site.
 * Each timer fires on its NCRONTAB schedule (interpreted in Eastern Time
 * thanks to WEBSITE_TIME_ZONE app setting) and POSTs to the corresponding
 * SWA endpoint with the x-timer-secret header.
 *
 * NCRONTAB format: {sec} {min} {hour} {day-of-month} {month} {day-of-week}
 * 0 = Sunday, 1 = Monday, ..., 5 = Friday
 */

const { app } = require("@azure/functions");

const SITE_URL = process.env.SITE_URL || "https://salmon-river-0a7a0c30f.1.azurestaticapps.net";

async function fire(route, ctx) {
  const secret = process.env.TIMER_SECRET;
  if (!secret) {
    ctx.error("TIMER_SECRET not set on cron Function App");
    return;
  }
  const url = `${SITE_URL}/api/${route}`;
  ctx.log(`POST ${url}`);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "x-timer-secret": secret, "content-type": "application/json" },
      // Allow up to 4 minutes (Function timeout default 5 min on Consumption)
      signal: AbortSignal.timeout(240_000),
    });
    const text = await resp.text();
    ctx.log(`HTTP ${resp.status} | ${text.slice(0, 500)}`);
    if (!resp.ok) ctx.error(`Non-2xx from ${route}: ${resp.status}`);
  } catch (err) {
    ctx.error(`Fetch ${route} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ATR Matrix EOD swing scan — weekdays at 4:30 PM ET (daily bar settled)
app.timer("atrScanCron", {
  schedule: "0 30 16 * * 1-5",
  handler: async (_t, ctx) => fire("atr-eod-timer", ctx),
});

// Catalyst Value Eval — 15 min before the open (9:15 AM ET), weekdays
app.timer("cveOpenCron", {
  schedule: "0 15 9 * * 1-5",
  handler: async (_t, ctx) => fire("cve-timer?phase=open", ctx),
});

// Catalyst Value Eval — 15 min before the close (3:45 PM ET), weekdays
app.timer("cveCloseCron", {
  schedule: "0 45 15 * * 1-5",
  handler: async (_t, ctx) => fire("cve-timer?phase=close", ctx),
});

// ── Metrics panels (MarketMetrics port) ────────────────────────────────────
// One panel per timer, staggered. The panels pace their own FinViz calls with
// deliberate gaps to avoid 429s, so Key Metrics alone can run for minutes —
// firing them together would blow the 5-minute Consumption timeout. Reads never
// compute on demand, so if these stop firing the tab silently goes stale.

// Screeners + movers change intraday; refresh mid-session and after the close.
app.timer("mmScreenersCron", {
  schedule: "0 5 12,16 * * 1-5",
  handler: async (_t, ctx) => fire("mm-timer?panel=screeners", ctx),
});

app.timer("mmMoversCron", {
  schedule: "0 10 12,16 * * 1-5",
  handler: async (_t, ctx) => fire("mm-timer?panel=movers", ctx),
});

// Breadth comes from a Google Sheet updated after the close.
app.timer("mmBreadthCron", {
  schedule: "0 20 17 * * 1-5",
  handler: async (_t, ctx) => fire("mm-timer?panel=breadth", ctx),
});

// The heavy FinViz panel — after the close only.
app.timer("mmKeyMetricsCron", {
  schedule: "0 45 17 * * 1-5",
  handler: async (_t, ctx) => fire("mm-timer?panel=key-metrics", ctx),
});

// Day-trade reversal scanning is no longer in this Function App. It moved
// to a local Python scanner (tools/chart-ocr/finviz_scanner.py) so reversal
// detection comes off the actual TOS chart instead of a server-side ZigZag.
// See AzharM82/tos-reversal-scanner repo for that pipeline.
