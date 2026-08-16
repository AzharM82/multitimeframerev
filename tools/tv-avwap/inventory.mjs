#!/usr/bin/env node
/**
 * Dump the bound chart's study/plot inventory. Read-only: it changes no symbol,
 * adds nothing to the chart, and publishes nothing.
 *
 * Run on DESKTOP2 with TradingView Desktop up on the 39m layout:
 *   node inventory.mjs [--symbol NASDAQ:MXL]
 *
 * Use it to wire level readers to the chart's OWN plots by title, instead of
 * recomputing levels and hoping they match.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDY_INVENTORY } from "./chart_js.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(HERE, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env */ }

const CDP_PORT = Number(process.env.TV_CDP_PORT || 9222);
const CHART_URL = process.env.TV_CHART_URL || "";
const args = process.argv.slice(2);
const symIdx = args.indexOf("--symbol");
const SYMBOL = symIdx >= 0 ? args[symIdx + 1] : "";

let targets;
try {
  targets = await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json());
} catch (e) {
  console.error(`TradingView CDP not reachable on :${CDP_PORT}. TradingView Desktop must have been ` +
                `LAUNCHED with --remote-debugging-port=${CDP_PORT} (the flag only applies at launch). ` +
                `See README / setup_tv_launch_task.ps1.`);
  process.exit(2);
}
const pages = targets.filter((t) => t.type === "page");
const target = CHART_URL
  ? pages.find((t) => t.url && t.url.includes(CHART_URL))
  : pages.find((t) => /tradingview\.com\/chart/i.test(t.url)) || pages.find((t) => /tradingview/i.test(t.url));
if (!target) {
  console.error(`No TradingView chart target on :${CDP_PORT}` + (CHART_URL ? ` matching TV_CHART_URL="${CHART_URL}"` : ""));
  process.exit(2);
}

function evaluate(ws, expression, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 30000);
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description || "eval error"));
      else resolve(msg.result?.result?.value);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 1;
const state = await evaluate(ws, `(function(){const c=window.TradingViewApi.activeChart();return {symbol:c.symbol(),resolution:String(c.resolution())};})()`, id++);
if (SYMBOL && SYMBOL !== state.symbol) {
  console.log(`switching ${state.symbol} -> ${SYMBOL} (will be restored)`);
  await evaluate(ws, `(function(){window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(SYMBOL)});return 'ok';})()`, id++);
  await new Promise((r) => setTimeout(r, 6000));
}

const inv = await evaluate(ws, STUDY_INVENTORY, id++);
const now = await evaluate(ws, `(function(){const c=window.TradingViewApi.activeChart();return {symbol:c.symbol(),resolution:String(c.resolution())};})()`, id++);

console.log(`\n=== ${now.symbol} @ ${now.resolution}m ===`);
for (const s of inv) {
  console.log(`\n--- ${s.title}`);
  if (s.shortDesc) console.log(`    shortDescription: ${s.shortDesc}`);
  console.log(`    plot order: ${JSON.stringify(s.plotOrder)}`);
  console.log(`    plot titles: ${JSON.stringify(s.styles)}`);
  if (s.lastTime) console.log(`    last bar: ${new Date(s.lastTime * 1000).toISOString()}`);
  console.log(`    last values: ${JSON.stringify(s.last)}`);
  console.log(`    prev values: ${JSON.stringify(s.prev)}`);
  if (s.inputs) console.log(`    inputs: ${JSON.stringify(s.inputs)}`);
}

if (SYMBOL && state.symbol !== now.symbol) {
  await evaluate(ws, `(function(){window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(state.symbol)});return 'ok';})()`, id++);
  console.log(`\nrestored symbol: ${state.symbol}`);
}
ws.close();
