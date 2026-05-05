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

// AVWAP EOD scan — weekdays at 4:15 PM ET (after market close)
app.timer("avwapEodCron", {
  schedule: "0 15 16 * * 1-5",
  handler: async (_t, ctx) => fire("avwap-eod-timer", ctx),
});

// Bull list email poll — every hour, 24/7
app.timer("bullEmailCron", {
  schedule: "0 0 * * * *",
  handler: async (_t, ctx) => fire("bull-email-timer", ctx),
});

// Bull list monitor — every 30 min, 9:00 AM to 4:30 PM ET, weekdays
app.timer("bullMonitorCron", {
  schedule: "0 0,30 9-16 * * 1-5",
  handler: async (_t, ctx) => fire("bull-monitor-timer", ctx),
});

// Day-trade reversal scan — every 10 min, 9:30 AM to 3:50 PM ET, weekdays
app.timer("dayTradeCron", {
  schedule: "0 */10 9-15 * * 1-5",
  handler: async (_t, ctx) => fire("day-trade-timer", ctx),
});
