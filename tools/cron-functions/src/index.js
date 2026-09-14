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

// ── Sector Desk + Index Leaders ────────────────────────────────────────────
// Real-time rotation board. Sector Desk warms every 5 min through the session
// (~24s compute: 12 paced FinViz exports); Index Leaders every 15 min (index
// leadership moves slower). Reads are cache-only, so if these stop the tab goes
// stale rather than computing on demand.
app.timer("sectorDeskCron", {
  schedule: "0 */5 9-15 * * 1-5",
  handler: async (_t, ctx) => fire("mm-timer?panel=sector-desk", ctx),
});

app.timer("indexLeadersCron", {
  schedule: "0 */15 9-15 * * 1-5",
  handler: async (_t, ctx) => fire("mm-timer?panel=index-leaders", ctx),
});

// History retention — trim SectorDeskHistory + OpeningDrive to 30 days.
// Daily at 6:10 PM ET, after all same-day writes have settled.
// Swing Strength: re-score the curated universe after the close (Polygon daily
// bars are final by then). Idempotent per ET day.
app.timer("swingScanCron", {
  schedule: "0 0 17 * * 1-5",
  handler: async (_timer, ctx) => fire("swing-scan", ctx),
});

app.timer("purgeHistoryCron", {
  schedule: "0 10 18 * * *",
  handler: async (_t, ctx) => fire("purge-history", ctx),
});

// Opening Drive — pre-market scan 2 min before the open (9:28 AM ET), weekdays.
// Produces the candidate list the Phase-2 engine then watches.
app.timer("openingDrivePremarketCron", {
  schedule: "0 28 9 * * 1-5",
  handler: async (_t, ctx) => fire("opening-drive-scan", ctx),
});

// Opening Drive — Phase-2 engine, every 2 min at ~10s past during the 9 & 10
// o'clock hours. The handler self-gates to the 9:30–10:30 ET window and no-ops
// when there are no candidates, so firing across the whole hour is harmless.
// Cloud-only (Alpaca IEX) — no local machine.
app.timer("openingDriveEngineCron", {
  schedule: "10 */2 9,10 * * 1-5",
  handler: async (_t, ctx) => fire("opening-drive-engine", ctx),
});

// Unusual options — the end-of-day sweep, weekdays at 5:05 PM ET.
//
// This one does NOT call a portal endpoint. Static Web Apps cuts a managed API
// request off at 45 seconds and sweeping 127 symbols against Tradier takes
// about four minutes, so the work runs here and writes the blob the portal's
// read proxy serves. Needs TRADIER_TOKEN and AZURE_STORAGE_CONNECTION_STRING
// on THIS Function App, and host.json's functionTimeout raised past the sweep.
//
// 5:05 PM rather than at the bell: consolidated volume keeps printing for a few
// minutes after the close, and a sweep run at 4:01 undercounts the last trades
// of the day — which is exactly the flow this screen exists to catch.
app.timer("uoaScanCron", {
  schedule: "0 5 17 * * 1-5",
  handler: async (_t, ctx) => {
    const { runScan } = require("./uoa/scan.js");
    try {
      const out = await runScan({ log: (m) => ctx.log(m) });
      ctx.log(`uoaScanCron: ${JSON.stringify(out)}`);
    } catch (err) {
      ctx.error(`uoaScanCron failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  },
});

// Unusual options, LIVE — the watch set, built once before the open.
//
// Walking the chains is the expensive half (about six minutes of Tradier calls)
// and nothing it collects changes during the session: open interest is
// recomputed by OCC overnight, so the figure this records at 8:40 is the right
// denominator until the close. Doing it once, while StockAgentHub's executor is
// still asleep and the whole rate limit is ours, is what makes the two-minute
// polling affordable.
app.timer("uoaWatchsetCron", {
  schedule: "0 40 8 * * 1-5",
  handler: async (_t, ctx) => {
    const { buildWatchSet } = require("./uoa/live.js");
    try {
      // UOA_FORCE=1 builds regardless of the exchange calendar. It exists so the
      // watch set can be rebuilt by hand after a failed morning — and so this
      // function can be proven in Azure on a closed day. Unset it afterwards.
      const force = process.env.UOA_FORCE === "1";
      ctx.log(`uoaWatchsetCron: ${JSON.stringify(await buildWatchSet({ log: (m) => ctx.log(m), force }))}`);
    } catch (err) {
      ctx.error(`uoaWatchsetCron failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  },
});

// Unusual options, LIVE — the poll, every two minutes through the session.
//
// Fires across the whole 9-to-16 block and self-gates to 09:30-16:00 ET, so a
// schedule edit can never produce readings from a closed market. One form POST
// per ~900 contracts, so a poll is a handful of requests rather than one per
// underlying, and it stays well clear of the executor's share of the token.
app.timer("uoaLiveCron", {
  schedule: "0 */2 9-16 * * 1-5",
  handler: async (_t, ctx) => {
    const { poll } = require("./uoa/live.js");
    try {
      // Same escape hatch as the build: UOA_FORCE=1 ignores the session gate so
      // the poll can be exercised outside market hours. Unset it afterwards.
      const out = await poll({ log: (m) => ctx.log(m), force: process.env.UOA_FORCE === "1" });
      if (out.polled) ctx.log(`uoaLiveCron: ${JSON.stringify(out)}`);
    } catch (err) {
      ctx.error(`uoaLiveCron failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  },
});

// The SPY breadth-streak regime cron (tvRegimeCron / tvRegimeSessionCron) was
// removed 2026-08-12. It kept a Gate snapshot warm so the streak webhook could
// qualify a streak inside TradingView's 3-second cancel. The SPY Conviction
// Score indicator that replaced that system emits its own decision, so there is
// nothing left to pre-compute — and a timer whose endpoint is gone fails every
// 15 minutes into a log nobody reads.

// Day-trade reversal scanning is no longer in this Function App. It moved
// to a local Python scanner (tools/chart-ocr/finviz_scanner.py) so reversal
// detection comes off the actual TOS chart instead of a server-side ZigZag.
// See AzharM82/tos-reversal-scanner repo for that pipeline.
