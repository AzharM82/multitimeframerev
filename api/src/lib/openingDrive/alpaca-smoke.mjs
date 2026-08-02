/**
 * Alpaca IEX client smoke test — run with YOUR Alpaca keys in the environment.
 *
 * Alpaca market-data keys are free (create at app.alpaca.markets → API keys; a
 * funded account is not required for IEX data). Then, from api/ after `npm run build`:
 *
 *   # PowerShell
 *   $env:ALPACA_API_KEY="<key>"; $env:ALPACA_API_SECRET="<secret>"
 *   node src/lib/openingDrive/alpaca-smoke.mjs
 *
 * Prints a few recent 2-min IEX bars for two liquid names, confirming auth, the
 * multi-symbol shape, and 9:30-boundary alignment. Nothing is stored or sent.
 */

import { fetchIexBars, isAlpacaConfigured } from "../../../dist/lib/alpaca.js";

if (!isAlpacaConfigured()) {
  console.error("Set ALPACA_API_KEY and ALPACA_API_SECRET (or APCA_API_KEY_ID / APCA_API_SECRET_KEY).");
  process.exit(2);
}

// Look back ~8 days so we catch a trading session regardless of weekends.
const start = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
const bars = await fetchIexBars(["AAPL", "MSFT"], "2Min", start);

for (const sym of ["AAPL", "MSFT"]) {
  const arr = bars.get(sym) ?? [];
  console.log(`\n${sym}: ${arr.length} IEX 2-min bars since ${start}`);
  for (const b of arr.slice(-4)) {
    const et = new Date(b.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${et} ET  O${b.open} H${b.high} L${b.low} C${b.close} V${b.volume}`);
  }
}
console.log("\nOK — Alpaca IEX client works. Add the same keys to the portal app settings to go live.");
