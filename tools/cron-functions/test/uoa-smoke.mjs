// Live smoke test: a handful of symbols through the real sweep, nothing written.
//   node test/uoa-smoke.mjs 2026-09-11 NVDA TSLA AAPL
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync("C:/Users/reach/dev/StockAgentAIHub.secrets/tradier.env","utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// the storage connection string lives in the API's gitignored local settings
try {
  const v = JSON.parse(fs.readFileSync("../../api/local.settings.json","utf8")).Values || {};
  if (v.AZURE_STORAGE_CONNECTION_STRING && !process.env.AZURE_STORAGE_CONNECTION_STRING) {
    process.env.AZURE_STORAGE_CONNECTION_STRING = v.AZURE_STORAGE_CONNECTION_STRING;
  }
} catch { /* baselines are optional for a dry run */ }
const { runScan } = require("../src/uoa/scan.js");
const [scanDate, ...syms] = process.argv.slice(2);
const out = await runScan({ scanDate, universe: syms, dryRun: true, log: (m)=>console.log(m) });
const p = out.payload;
console.log(`\ncontracts ${p.contracts_scanned}  fired ${p.contracts_fired}  failed ${p.failed.length}`);
for (const s of p.signals.slice(0,8)) {
  console.log(`  ${s.underlying} ${s.expiry} ${s.strike}${s.type}  vol ${s.todayVolume} / OI ${s.priorOi} = ${s.volOiRatio}x  $${Math.round(s.notionalPremium).toLocaleString()}  score ${s.anomalyScore}`);
}
for (const a of p.aggregates.slice(0,5)) console.log(`  AGG ${a.underlying}: calls ${a.callVolume} puts ${a.putVolume} P/C ${a.putCallRatio} $${Math.round(a.notional).toLocaleString()}`);
