// Run the real sweep once, by hand. Publishes unless --dry is passed.
//   node test/uoa-run-once.mjs 2026-09-11 [--dry]
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync("C:/Users/reach/dev/StockAgentAIHub.secrets/tradier.env","utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const v = JSON.parse(fs.readFileSync("../../api/local.settings.json","utf8")).Values || {};
process.env.AZURE_STORAGE_CONNECTION_STRING ||= v.AZURE_STORAGE_CONNECTION_STRING;
const { runScan } = require("../src/uoa/scan.js");
const args = process.argv.slice(2);
const out = await runScan({ scanDate: args.find(a=>/^\d{4}-/.test(a)), dryRun: args.includes("--dry"), log: (m)=>console.log(m) });
console.log("\nRESULT", JSON.stringify({ ...out, payload: undefined }));
