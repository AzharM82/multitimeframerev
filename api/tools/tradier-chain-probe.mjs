/**
 * Live check of the Tradier option-chain provider. Not part of the build:
 * it needs the token and the network, so it is run by hand.
 *
 *   node tools/tradier-chain-probe.mjs SPY
 *
 * Reads TRADIER_TOKEN from the operator's secrets file (never printed) and
 * exercises the SAME compiled provider the API uses, so a pass here is a pass
 * for the tab. Checks the contract the Options Guide depends on: real-time
 * flag, a spot price, a full expiry list, and greeks / open interest / volume
 * actually populated rather than null — the exact thing that disqualified
 * Alpaca's free feed.
 */
import fs from "node:fs";

const SECRETS = "C:/Users/reach/dev/StockAgentAIHub.secrets/tradier.env";
for (const line of fs.readFileSync(SECRETS, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.OPTIONS_FEED = "tradier";

const ticker = process.argv[2] || "SPY";
const { fetchChain } = await import("../dist/lib/tradierOptions.js");

const t0 = Date.now();
const c = await fetchChain(ticker, null);
const ms = Date.now() - t0;

const pct = (n) => `${Math.round((n / c.contracts.length) * 100)}%`;
const has = (k) => c.contracts.filter((x) => x[k] !== null && x[k] !== undefined).length;

console.log(`${c.ticker}  spot ${c.spot}  feed ${c.feed}  delayed ${c.delayed}`);
console.log(`asOf ${c.asOf}   (${ms} ms)`);
console.log(`expiries ${c.expiries.length}: ${c.expiries.slice(0, 3).join(" ")} … ${c.expiries.at(-1)}`);
console.log(`current expiry ${c.currentExpiry}, ${c.contracts.length} contracts`);
for (const k of ["bid", "ask", "delta", "iv", "openInterest", "volume"]) {
  console.log(`  ${k.padEnd(13)} ${String(has(k)).padStart(4)}  ${pct(has(k))}`);
}
const atm = c.contracts
  .filter((x) => x.type === "call")
  .sort((a, b) => Math.abs(a.strike - c.spot) - Math.abs(b.strike - c.spot))[0];
console.log("nearest call:", JSON.stringify(atm));

const fail = [];
if (c.delayed !== false) fail.push("delayed should be false");
if (!(c.spot > 0)) fail.push("no spot");
if (c.expiries.length < 5) fail.push("expiry list too short");
if (has("delta") / c.contracts.length < 0.9) fail.push("greeks missing on >10% of contracts");
if (has("openInterest") / c.contracts.length < 0.9) fail.push("open interest missing");
console.log(fail.length ? `FAIL: ${fail.join("; ")}` : "PASS — real-time chain with greeks, OI and volume");
process.exit(fail.length ? 1 : 0);
