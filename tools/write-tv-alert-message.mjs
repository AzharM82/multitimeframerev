/**
 * Writes the paste-ready TradingView alert body, with the webhook secret in it,
 * to a local gitignored file — and mirrors the secret into api/local.settings.json
 * so `swa start` validates against the same value as production.
 *
 * The secret arrives via the TV_SECRET env var (read from Azure by the caller),
 * never as an argument, so it stays out of shell history and process listings.
 *
 *   $env:TV_SECRET = <from az>; node tools/write-tv-alert-message.mjs
 */
import fs from "node:fs";

const secret = process.env.TV_SECRET;
if (!secret || secret.length < 16) {
  console.error("TV_SECRET not set (or too short) — refusing to write a placeholder");
  process.exit(1);
}

const settingsPath = "api/local.settings.json";
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.Values = settings.Values || {};
settings.Values.TV_WEBHOOK_SECRET = secret;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

const alertBody = {
  event: "trend_start",
  trend: "green",
  source: "4-Chart Majority Trend Webhook Alerts",
  timeframe: "5",
  time: "{{timenow}}",
  secret,
};

const out = "tools/tv-trend-alert-message.txt";
fs.writeFileSync(
  out,
  [
    "TradingView alert setup — SPY 5-min breadth streak",
    "==================================================",
    "",
    "Webhook URL (paste into the alert's 'Webhook URL' field):",
    "  https://salmon-river-0a7a0c30f.1.azurestaticapps.net/api/tv-trend-webhook",
    "",
    "Alert message (paste into the 'Message' box, verbatim).",
    "The secret line is what authenticates the call — keep this file private.",
    "",
    JSON.stringify(alertBody, null, 2),
    "",
    "Create four alerts, changing ONLY event and trend:",
    "    trend_start + green      trend_end + green",
    "    trend_start + red        trend_end + red",
    "",
    "If your Pine fires a single alert() with a dynamic message, keep this JSON",
    "shape and substitute event/trend. The receiver also accepts plain text that",
    "contains green/red plus start/end and secret=<value>, but JSON is preferred:",
    "the text path refuses anything ambiguous and is only a safety net.",
    "",
    "Rotate: set a new TV_WEBHOOK_SECRET in the SWA app settings, re-run",
    "  $env:TV_SECRET = '<new>'; node tools/write-tv-alert-message.mjs",
    "and update the four TradingView alerts.",
    "",
  ].join("\n"),
);

console.log(`wrote ${out}`);
console.log(`updated ${settingsPath} (gitignored)`);
