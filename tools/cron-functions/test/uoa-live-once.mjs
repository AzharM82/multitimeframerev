// Drive the intraday engine by hand.
//   node test/uoa-live-once.mjs build [SYM ...]
//   node test/uoa-live-once.mjs poll
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
for (const l of fs.readFileSync("C:/Users/reach/dev/StockAgentAIHub.secrets/tradier.env","utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const v = JSON.parse(fs.readFileSync("../../api/local.settings.json","utf8")).Values || {};
process.env.AZURE_STORAGE_CONNECTION_STRING ||= v.AZURE_STORAGE_CONNECTION_STRING;
// Alert credentials come from the deployed cron app so a by-hand run exercises
// the same selection path production will. Sending still requires --send.
if (!process.env.PUSHOVER_APP_TOKEN) {
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync('az functionapp config appsettings list -n mtfrev-cron -g rg-mtfrev -o json', { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });
    for (const kv of JSON.parse(out)) {
      if (/^(PUSHOVER_|WHATSAPP_)/.test(kv.name) && !process.env[kv.name]) process.env[kv.name] = kv.value;
    }
  } catch { /* alerting simply stays unconfigured */ }
}
const L = require("../src/uoa/live.js");
const [mode, ...rest] = process.argv.slice(2);
const day = rest.find(a=>/^\d{4}-/.test(a));
const syms = rest.filter(a=>!/^\d{4}-/.test(a));
const log = (m)=>console.log(m);
if (mode === "build") console.log("RESULT", JSON.stringify(await L.buildWatchSet({ log, force:true, day, ...(syms.length?{universe:syms}:{}) })));
else console.log("RESULT", JSON.stringify(await L.poll({ log, force:true, day, alertDryRun: !rest.includes("--send") })));
