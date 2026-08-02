/**
 * Opening Drive — unit tests for the gate/trigger/wick/RVOL/alignment math.
 *
 * Runs against the COMPILED output so the assertions exercise exactly what ships.
 * Build first (`npm run build` in api/), then:
 *   node src/lib/openingDrive/trigger.test.mjs   (from api/, resolves to dist/)
 */

import assert from "node:assert";
import {
  evaluateGate,
  evaluateTrigger,
  rvolTod,
  isAlignedBarOpen,
  etMinutes,
  rollToBars,
} from "../../../dist/lib/openingDrive/trigger.js";
import { loadConfig } from "../../../dist/lib/openingDrive/config.js";

const cfg = loadConfig();
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failures++; console.log(`  FAIL  ${label}\n        ${e.message}`); }
}

// A timestamp helper: build an ET wall-clock time on a fixed weekday (2025-05-08).
function etTs(hh, mm) {
  // 2025-05-08 is EDT (UTC-4). 09:30 ET = 13:30 UTC.
  return Date.UTC(2025, 4, 8, hh + 4, mm, 0);
}

console.log("\ngate (spec STEP A)");
check("gap mode: passes when open clears both", () => {
  const g = evaluateGate(23.03, 22.48, 22.29, "gap");
  assert.strictEqual(g.pass, true);
  assert.strictEqual(g.clearedYdayHigh, true);
});
check("gap mode: passes on gap over prior close even below yday_high (RGTI case)", () => {
  // RGTI 2025-05-22: open 11.03 > prior close 10.96, below yday high 12.07
  const g = evaluateGate(11.03, 12.07, 10.96, "gap");
  assert.strictEqual(g.pass, true);
  assert.strictEqual(g.clearedYdayHigh, false);
});
check("gap mode: fails when open <= prior_close", () => {
  assert.strictEqual(evaluateGate(10.90, 12.07, 10.96, "gap").pass, false);
});
check("strict mode: rejects the RGTI gap-under-yday-high case", () => {
  const g = evaluateGate(11.03, 12.07, 10.96, "strict");
  assert.strictEqual(g.pass, false);
  assert.strictEqual(g.clearedYdayHigh, false);
});
check("strict mode: passes when open clears yday_high", () => {
  assert.strictEqual(evaluateGate(23.03, 22.48, 22.29, "strict").pass, true);
});

console.log("\ntrigger (spec STEP B)");
const bar = (o, h, l, c, v = 1_000_000) => ({ open: o, high: h, low: l, close: c, volume: v, timestamp: etTs(9, 32) });

check("fires: close>PMH, green, tight wick, rvol ok", () => {
  const chk = evaluateTrigger(bar(86.5, 88.3, 86.2, 88.18), 87.9, 5.0, cfg);
  assert.strictEqual(chk.fired, true);
  assert.strictEqual(chk.stuffed, false);
});
check("no fire when close <= PMH", () => {
  const chk = evaluateTrigger(bar(86.5, 88.3, 86.2, 87.8), 87.9, 5.0, cfg);
  assert.strictEqual(chk.fired, false);
});
check("stuffed: wick above PMH but closes below", () => {
  const chk = evaluateTrigger(bar(86.5, 88.3, 86.2, 87.5), 87.9, 5.0, cfg);
  assert.strictEqual(chk.fired, false);
  assert.strictEqual(chk.stuffed, true);
});
check("no fire on red body even above PMH", () => {
  const chk = evaluateTrigger(bar(88.5, 88.6, 88.0, 88.1), 87.9, 5.0, cfg);
  assert.strictEqual(chk.fired, false);
});
check("wick filter rejects a top-heavy bar", () => {
  // body = 0.5, upper wick = 1.0 → 1.0 > 0.5*0.5 → fails
  const chk = evaluateTrigger(bar(87.95, 89.0, 87.9, 88.45), 87.9, 5.0, cfg);
  assert.strictEqual(chk.fired, false);
});
check("wick filter accepts a bar with wick == 0.5*body", () => {
  // body = 1.0, upper wick = 0.5 → 0.5 <= 0.5*1.0 → passes
  const chk = evaluateTrigger(bar(88.0, 89.5, 87.95, 89.0), 87.9, 5.0, cfg);
  assert.strictEqual(chk.fired, true);
});
check("rvol below min blocks the fire", () => {
  const chk = evaluateTrigger(bar(88.0, 89.5, 87.95, 89.0), 87.9, 2.9, cfg);
  assert.strictEqual(chk.fired, false);
});

console.log("\nrvol time-slot averaging");
check("rvol = bar vol / avg of prior same-slot vols", () => {
  assert.strictEqual(rvolTod(300_000, [100_000, 100_000, 100_000]), 3);
});
check("rvol = 0 when no history (unknowable)", () => {
  assert.strictEqual(rvolTod(300_000, []), 0);
});
check("rvol ignores zero/NaN slot vols", () => {
  assert.strictEqual(rvolTod(200_000, [0, NaN, 100_000]), 2);
});

console.log("\n2-min alignment (spec STEP B)");
check("9:30 is an aligned bar open", () => assert.strictEqual(isAlignedBarOpen(etTs(9, 30), 2), true));
check("9:32 is aligned", () => assert.strictEqual(isAlignedBarOpen(etTs(9, 32), 2), true));
check("9:31 is NOT aligned", () => assert.strictEqual(isAlignedBarOpen(etTs(9, 31), 2), false));
check("etMinutes reads ET wall clock (9:30 -> 570)", () => assert.strictEqual(etMinutes(etTs(9, 30)), 570));

console.log("\nrollToBars (1-min -> 2-min, 9:30 boundary exact)");
check("groups 9:30 and 9:31 into one 9:30 bar", () => {
  const oneMin = [
    { open: 100, high: 101, low: 99.5, close: 100.5, volume: 10, timestamp: etTs(9, 30) },
    { open: 100.5, high: 102, low: 100.2, close: 101.8, volume: 20, timestamp: etTs(9, 31) },
    { open: 101.8, high: 103, low: 101.5, close: 102.5, volume: 15, timestamp: etTs(9, 32) },
  ];
  const bars = rollToBars(oneMin, 2);
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[0].open, 100);
  assert.strictEqual(bars[0].close, 101.8); // last close in the 9:30-9:31 bucket
  assert.strictEqual(bars[0].high, 102);
  assert.strictEqual(bars[0].volume, 30);
  assert.strictEqual(bars[1].open, 101.8); // 9:32 starts a fresh bar
});
check("drops pre-market 1-min bars from RTH roll-up", () => {
  const oneMin = [
    { open: 1, high: 1, low: 1, close: 1, volume: 5, timestamp: etTs(9, 0) }, // pre-market
    { open: 100, high: 101, low: 99, close: 100.5, volume: 10, timestamp: etTs(9, 30) },
  ];
  const bars = rollToBars(oneMin, 2);
  assert.strictEqual(bars.length, 1);
  assert.strictEqual(bars[0].open, 100);
});

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
