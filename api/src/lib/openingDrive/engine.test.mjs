/**
 * Opening Drive — Phase-2 engine unit tests (offline, no Alpaca).
 *
 * Feeds synthetic IEX-shaped bars to the pure engine functions and asserts the
 * gate/trigger/stuffed/exit transitions. Build first, then:
 *   node src/lib/openingDrive/engine.test.mjs   (from api/)
 */

import assert from "node:assert";
import {
  premarketHigh,
  buildSlotBaseline,
  evaluateCandidate,
} from "../../../dist/lib/openingDrive/engine.js";
import { loadConfig } from "../../../dist/lib/openingDrive/config.js";

const cfg = loadConfig();
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failures++; console.log(`  FAIL  ${label}\n        ${e.message}`); }
}

// 2025-05-22 is EDT (UTC-4): 09:30 ET = 13:30 UTC.
function etTs(hh, mm, day = 22) { return Date.UTC(2025, 4, day, hh + 4, mm, 0); }
const bar = (hh, mm, o, h, l, c, v, day = 22) => ({ open: o, high: h, low: l, close: c, volume: v, timestamp: etTs(hh, mm, day) });

console.log("\npremarketHigh");
check("takes the max high over 04:00–09:30 only", () => {
  const bars = [bar(8, 0, 10, 12, 9.9, 11, 100), bar(9, 20, 11, 13, 10.8, 12.5, 200), bar(9, 32, 12.5, 14, 12.4, 13.8, 300)];
  assert.strictEqual(premarketHigh(bars), 13); // 9:32 (RTH) excluded
});

console.log("\nbuildSlotBaseline");
check("averages same 2-min slot across distinct prior days", () => {
  const bars = [
    bar(9, 30, 1, 1, 1, 1, 100, 19), // Mon 9:30 slot
    bar(9, 30, 1, 1, 1, 1, 300, 20), // Tue 9:30 slot
    bar(9, 32, 1, 1, 1, 1, 50, 19),  // Mon 9:32 slot
  ];
  const base = buildSlotBaseline(bars);
  assert.strictEqual(base[570], 200); // (100+300)/2 at 9:30
  assert.strictEqual(base[572], 50);  // one day at 9:32
});

console.log("\nevaluateCandidate — gate");
const baseCand = { ticker: "T", priorClose: 100, ydayHigh: 101, state: null };
check("GATE_FAIL when open <= prior close", () => {
  // 9:30 bar opens at 99.5 (< prior close 100)
  const bars = [bar(9, 20, 100, 101, 99, 100.5, 5000), bar(9, 30, 99.5, 100, 99, 99.8, 4000)];
  const out = evaluateCandidate({ ...baseCand }, bars, {}, cfg, etTs(9, 40));
  assert.strictEqual(out.kind, "GATE_FAIL");
});
check("GATE_PASS (gap over prior close, below yday high) with no trigger", () => {
  const bars = [bar(9, 20, 100, 100.5, 99.8, 100.4, 5000), bar(9, 30, 100.5, 100.8, 100.2, 100.6, 4000)];
  const out = evaluateCandidate({ ...baseCand }, bars, { 570: 1_000_000 }, cfg, etTs(9, 34));
  assert.strictEqual(out.kind, "GATE_PASS");
  assert.strictEqual(out.clearedYdayHigh, false);
});

console.log("\nevaluateCandidate — trigger");
check("TRIGGERED when a bar closes over PMH, green, tight wick, rvol ok", () => {
  // premarket high 100.5; 9:32 bar closes 101.2 over it, green, tiny wick, big vol
  const bars = [
    bar(9, 20, 100, 100.5, 99.8, 100.3, 5000),     // premarket, PMH = 100.5
    bar(9, 30, 100.4, 100.6, 100.1, 100.45, 4000), // open bar (gate)
    bar(9, 32, 100.5, 101.25, 100.45, 101.2, 30000), // breakout bar
  ];
  const baseline = { 572: 5000 }; // 9:32 slot avg → rvol = 30000/5000 = 6
  const out = evaluateCandidate({ ...baseCand }, bars, baseline, cfg, etTs(9, 40));
  assert.strictEqual(out.kind, "TRIGGERED");
  assert.strictEqual(out.entry, 101.2);
  assert.strictEqual(out.stop, 100.45);
  assert.ok(out.rvol >= 3, `rvol ${out.rvol}`);
  assert.ok(out.suggestedShares > 0);
});
check("STUFFED when a bar wicks over PMH but closes under", () => {
  const bars = [
    bar(9, 20, 100, 100.5, 99.8, 100.3, 5000),      // PMH 100.5
    bar(9, 30, 100.4, 100.6, 100.1, 100.45, 4000),
    bar(9, 32, 100.4, 100.9, 100.3, 100.4, 30000),  // wick to 100.9 > PMH, close 100.4 < PMH
  ];
  const out = evaluateCandidate({ ...baseCand }, bars, { 572: 5000 }, cfg, etTs(9, 40));
  assert.strictEqual(out.kind, "STUFFED");
});

console.log("\nevaluateCandidate — post-trigger monitor");
check("EXIT when a later bar low takes out the stop", () => {
  const cand = { ...baseCand, state: "TRIGGERED", entry: 101.2, stop: 100.45, pmHighUsed: 100.5 };
  const bars = [
    bar(9, 20, 100, 100.5, 99.8, 100.3, 5000),
    bar(9, 30, 100.4, 100.6, 100.1, 100.45, 4000),
    bar(9, 32, 100.5, 101.25, 100.45, 101.2, 30000),
    bar(9, 34, 101.2, 101.3, 100.2, 100.4, 8000), // low 100.2 < stop 100.45
  ];
  const out = evaluateCandidate(cand, bars, {}, cfg, etTs(9, 40));
  assert.strictEqual(out.kind, "EXIT");
  assert.ok(/STOPPED/.test(out.reason));
});
check("EXIT (failure) when a later bar closes back below PMH", () => {
  const cand = { ...baseCand, state: "TRIGGERED", entry: 101.2, stop: 100.45, pmHighUsed: 100.5 };
  const bars = [
    bar(9, 20, 100, 100.5, 99.8, 100.3, 5000),
    bar(9, 30, 100.4, 100.6, 100.1, 100.45, 4000),
    bar(9, 32, 100.5, 101.25, 100.45, 101.2, 30000),
    bar(9, 34, 101.2, 101.3, 100.46, 100.3, 8000), // close 100.3 < PMH 100.5, low 100.46 above stop
  ];
  const out = evaluateCandidate(cand, bars, {}, cfg, etTs(9, 40));
  assert.strictEqual(out.kind, "EXIT");
  assert.ok(/FAILURE/.test(out.reason));
});
check("no duplicate transition once already TRIGGERED and holding", () => {
  const cand = { ...baseCand, state: "TRIGGERED", entry: 101.2, stop: 100.45, pmHighUsed: 100.5 };
  const bars = [
    bar(9, 20, 100, 100.5, 99.8, 100.3, 5000),
    bar(9, 30, 100.4, 100.6, 100.1, 100.45, 4000),
    bar(9, 32, 100.5, 101.25, 100.45, 101.2, 30000),
    bar(9, 34, 101.2, 101.6, 100.9, 101.5, 8000), // holding above PMH and stop
  ];
  const out = evaluateCandidate(cand, bars, {}, cfg, etTs(9, 40));
  assert.strictEqual(out.kind, "none");
});

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
