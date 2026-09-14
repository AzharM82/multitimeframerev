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
const L = require("../src/uoa/live.js");
const [mode, ...rest] = process.argv.slice(2);
const day = rest.find(a=>/^\d{4}-/.test(a));
const syms = rest.filter(a=>!/^\d{4}-/.test(a));
const log = (m)=>console.log(m);
if (mode === "build") console.log("RESULT", JSON.stringify(await L.buildWatchSet({ log, force:true, day, ...(syms.length?{universe:syms}:{}) })));
else console.log("RESULT", JSON.stringify(await L.poll({ log, force:true, day })));
