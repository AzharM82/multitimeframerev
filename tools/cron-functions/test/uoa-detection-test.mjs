/**
 * Unusual options detection — assertions, no network.
 *
 *   node test/uoa-detection-test.mjs
 *
 * The scan runs once a day after the close, so a bad rule is not visible until
 * the next morning and costs a whole session. Every gate is a pure function
 * precisely so it can be pinned here instead.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const D = require("../src/uoa/detection.js");

let checks = 0;
const fails = [];
function ok(cond, what) {
  checks += 1;
  if (!cond) fails.push(what);
}
function eq(actual, expected, what) {
  ok(Object.is(actual, expected), `${what} — expected ${expected}, got ${actual}`);
}

const SCAN = "2026-09-14";
const thr = D.DEFAULT_THRESHOLDS;

// ── date arithmetic ────────────────────────────────────────────────────────
eq(D.dte("2026-09-14", "2026-10-16"), 32, "dte across a month");
eq(D.dte("2026-12-28", "2027-01-15"), 18, "dte across a year");
eq(D.dte("2026-09-14", "2026-09-14"), 0, "dte same day");
ok(D.inDteWindow(SCAN, "2026-10-16", thr), "32 days is in the window");
ok(!D.inDteWindow(SCAN, "2026-09-18", thr), "4 days is out");
ok(!D.inDteWindow(SCAN, "2026-12-18", thr), "95 days is out");
ok(D.inDteWindow(SCAN, "2026-10-09", thr), "25 days is the inclusive lower edge");
ok(D.inDteWindow(SCAN, "2026-10-19", thr), "35 days is the inclusive upper edge");
ok(!D.inDteWindow(SCAN, "2026-10-08", thr), "24 days is outside");
ok(!D.inDteWindow(SCAN, "2026-10-20", thr), "36 days is outside");

// ── moneyness ──────────────────────────────────────────────────────────────
ok(D.inMoneyness(100, 100, thr), "at the money");
ok(D.inMoneyness(125, 100, thr), "25% up is the edge");
ok(!D.inMoneyness(126, 100, thr), "26% up is a wing");
ok(!D.inMoneyness(70, 100, thr), "30% down is a wing");
ok(D.inMoneyness(1000, 0, thr), "no spot lets the contract through rather than dropping it");

// ── the open-interest gate, which is the whole point ───────────────────────
const base = {
  occSymbol: "NVDA261016C00200000", underlying: "NVDA", type: "C",
  strike: 200, expiry: "2026-10-16", todayVolume: 10_000, priorOi: 1_000,
  lastPrice: 5, volumeHistory: [],
};
let m = D.contractMetrics(base, thr);
eq(m.volOiRatio, 10, "10k volume on 1k open interest is 10x");
eq(m.notionalPremium, 5_000_000, "notional is volume x price x 100");
eq(m.volRatio, null, "no history means no volume ratio, not a guessed one");
eq(m.baselineDays, 0, "baseline days reported honestly");
ok(D.passes(base, m, thr), "a 10x vol/OI print with $5m notional fires");

m = D.contractMetrics({ ...base, priorOi: 5_000 }, thr);
eq(m.volOiRatio, 2, "2x is below the 3x threshold");
ok(!D.passes({ ...base, priorOi: 5_000 }, m, thr), "2x does not fire");

// OI under the floor is unmeasurable, NOT infinitely unusual. This is the
// single most common way an unusual-options screen fills with garbage.
const thinOi = { ...base, priorOi: 4 };
m = D.contractMetrics(thinOi, thr);
eq(m.volOiRatio, null, "open interest below the floor gives no ratio");
ok(!D.passes(thinOi, m, thr), "a contract with almost no open interest never fires");
const noOi = { ...base, priorOi: null };
ok(!D.passes(noOi, D.contractMetrics(noOi, thr), thr), "missing open interest never fires");

// ── the other gates ────────────────────────────────────────────────────────
const smallVol = { ...base, todayVolume: 400, priorOi: 50 };
ok(!D.passes(smallVol, D.contractMetrics(smallVol, thr), thr), "under 500 lots never fires however unusual");
const cheap = { ...base, lastPrice: 0.05, todayVolume: 10_000, priorOi: 1_000 };
m = D.contractMetrics(cheap, thr);
eq(m.notionalPremium, 50_000, "penny contract notional");
ok(!D.passes(cheap, m, thr), "under $100k committed does not fire");

// ── the secondary volume ratio, once history exists ────────────────────────
const short = { ...base, volumeHistory: [10, 10, 10] };
m = D.contractMetrics(short, thr);
eq(m.volRatio, null, "3 sessions is not enough history to judge");
ok(D.passes(short, m, thr), "and the gate is skipped rather than failing the contract");

const quiet = Array(12).fill(10);
const withHistory = { ...base, volumeHistory: quiet };
m = D.contractMetrics(withHistory, thr);
eq(m.baselineDays, 12, "12 sessions counted");
eq(m.volRatio, 1000, "10k against a 10-lot average is 1000x");
ok(D.passes(withHistory, m, thr), "1000x clears the 100x secondary gate");

const busy = { ...base, volumeHistory: Array(12).fill(5_000) };
m = D.contractMetrics(busy, thr);
eq(m.volRatio, 2, "10k against a 5k average is only 2x");
ok(!D.passes(busy, m, thr), "a contract that always trades this much is not unusual");

// The average is floored, so a dead contract cannot manufacture a ratio.
const dead = { ...base, volumeHistory: Array(12).fill(0) };
m = D.contractMetrics(dead, thr);
eq(m.avgVolume20d, 0, "raw average reported as it is");
eq(m.volRatio, 2000, "but the ratio uses the floor of 5, not 0");

// ── scoring ────────────────────────────────────────────────────────────────
const loud = D.contractMetrics({ ...base, todayVolume: 50_000, priorOi: 1_000 }, thr);
ok(loud.anomalyScore > D.contractMetrics(base, thr).anomalyScore, "more volume on the same OI ranks higher");
const rich = D.contractMetrics({ ...base, lastPrice: 50 }, thr);
ok(rich.anomalyScore > D.contractMetrics(base, thr).anomalyScore, "more money committed ranks higher");
ok(D.contractMetrics(base, thr).anomalyScore > 0, "a contract with no history still scores above zero");

// ── the full evaluation ────────────────────────────────────────────────────
eq(D.evaluateContract(base, SCAN, 200, thr).underlying, "NVDA", "a qualifying contract returns a signal");
eq(D.evaluateContract({ ...base, expiry: "2026-09-18" }, SCAN, 200, thr), null, "out of the DTE window returns null");
eq(D.evaluateContract(base, SCAN, 100, thr), null, "a strike 100% above spot is a wing");
eq(D.evaluateContract({ ...base, lastPrice: 0 }, SCAN, 200, thr), null, "an unpriced contract returns null");
eq(D.evaluateContract(base, SCAN, 200, thr).dte, 32, "the signal carries its own DTE");

// ── aggregates ─────────────────────────────────────────────────────────────
const obs = [
  { underlying: "NVDA", type: "C", todayVolume: 1_000, priorOi: 500, lastPrice: 2 },
  { underlying: "NVDA", type: "P", todayVolume: 2_000, priorOi: 800, lastPrice: 1 },
  { underlying: "AAPL", type: "C", todayVolume: 100, priorOi: 50, lastPrice: 1 },
];
const agg = D.aggregate(obs);
eq(agg.length, 2, "one row per underlying");
eq(agg[0].underlying, "NVDA", "sorted by dollars committed");
eq(agg[0].callVolume, 1_000, "call volume summed");
eq(agg[0].putVolume, 2_000, "put volume summed");
eq(agg[0].putCallRatio, 2, "twice as many puts as calls");
eq(agg[0].totalVolume, 3_000, "total volume");
eq(agg[0].notional, 400_000, "notional across both sides");
eq(D.aggregate([{ underlying: "X", type: "P", todayVolume: 5, priorOi: 1, lastPrice: 1 }])[0].putCallRatio,
  null, "no calls gives no ratio rather than infinity");

// ── baseline accumulation ──────────────────────────────────────────────────
let bl = D.updateBaselines({}, [{ occSymbol: "A", todayVolume: 100 }], thr);
eq(bl.A.length, 1, "first session starts a history");
bl = D.updateBaselines(bl, [{ occSymbol: "A", todayVolume: 200 }], thr);
eq(bl.A.join(","), "100,200", "second session appends, oldest first");
bl = D.updateBaselines(bl, [{ occSymbol: "B", todayVolume: 7 }], thr);
eq(bl.A.join(","), "100,200", "a contract absent today keeps its history");
eq(bl.B.length, 1, "a new contract starts its own");
let long = {};
for (let i = 0; i < 25; i += 1) long = D.updateBaselines(long, [{ occSymbol: "A", todayVolume: i }], thr);
eq(long.A.length, 20, "the window never exceeds 20 sessions");
eq(long.A[19], 24, "the newest session is last");
eq(long.A[0], 5, "the oldest sessions fall off the front");

if (fails.length) {
  console.error(`FAIL — ${fails.length} of ${checks} checks\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`PASS — ${checks} assertions (dte + moneyness + OI gate + baseline + scoring + aggregates)`);
