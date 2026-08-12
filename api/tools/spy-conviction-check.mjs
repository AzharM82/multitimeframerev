/**
 * Parity check for the SPY Conviction parser + state machine.
 *
 * Mirrors dev/spy-conviction/tests/test_webhook.py, which was written against
 * the Python reference implementation before this was ported into the portal.
 * Same cases, same expected answers — the point is that the port did not change
 * behaviour, so the two can be compared line for line.
 *
 * Covers the pure half only (parse, dedupe key, transitions, notify gate). The
 * durable half — Table dedupe, notification fan-out, the audit read — is
 * exercised against a running `swa start`, because a fake for Table Storage
 * would only prove the fake works.
 *
 *   node api/tools/spy-conviction-check.mjs      (after `cd api && npm run build`)
 */

import {
  parseConviction, dedupeKey, formatAlert, NOTIFY_ACTIONS,
} from "../dist/lib/spyConviction/models.js";
import { applySignal } from "../dist/lib/spyConviction/state.js";

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}

function eq(actual, expected, what = "value") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

/** The exact BASE payload from the Python tests. */
const BASE = {
  strategy: "SPY_CONVICTION", signal: "BUY_PUT", action: "BUY", side: "PUT",
  grade: "STRONG", bias: "downside", score: -67, legs_agree: 6,
  entry_trigger: "vwap_reclaim", entry_dist_atr: 0.12, ext_atr: -0.44,
  bars_held: 0, entry_score: -67, entry_px: 770.45, block_reason: "none",
  spy: 770.45, vwap: 771.64, ema9: 770.98, atr: 0.83, vix: 15.33,
  tick: -36, cvd: -90000, breadth_ratio: 3.4910,
  tf: "10", chart_symbol: "SPY", bar_time: "2026-08-12 09:50:00",
};
const alert = (o = {}) => JSON.stringify({ ...BASE, ...o });
const parsed = (o = {}) => {
  const r = parseConviction(alert(o));
  if (!r.ok) throw new Error(`unexpected parse failure: ${r.reason}`);
  return r.alert;
};

console.log("\nparsing");

check("plain JSON body parses", () => {
  const a = parsed();
  eq(a.signal, "BUY_PUT"); eq(a.action, "BUY"); eq(a.side, "PUT");
  eq(a.score, -67); eq(a.legsAgree, 6); eq(a.spy, 770.45);
  eq(a.barTime, "2026-08-12 09:50:00");
});

check("JSON wrapped in stray text is still parsed", () => {
  const r = parseConviction("alert fired: " + alert({ signal: "ARM_PUT", action: "ARM" }));
  ok(r.ok, "wrapped body rejected");
  eq(r.alert.signal, "ARM_PUT");
});

check("a leading BOM does not break parsing", () => {
  ok(parseConviction("﻿" + alert()).ok, "BOM body rejected");
});

check("non-JSON body is rejected, not guessed at", () => {
  const r = parseConviction("this is not json at all");
  ok(!r.ok, "garbage accepted");
});

check("valid JSON with an unknown signal is rejected", () => {
  const r = parseConviction(JSON.stringify({
    strategy: "X", signal: "NOT_A_SIGNAL", action: "BUY", bar_time: "2026-08-12 09:50:00",
  }));
  ok(!r.ok, "unknown signal accepted");
  ok(/NOT_A_SIGNAL/.test(r.reason), `reason should name the signal, got "${r.reason}"`);
});

check("missing bar_time is rejected (it is half the dedupe key)", () => {
  const body = { ...BASE }; delete body.bar_time;
  ok(!parseConviction(JSON.stringify(body)).ok, "missing bar_time accepted");
});

check("an unknown future field does not stop the feed", () => {
  const r = parseConviction(alert({ brand_new_column: 42 }));
  ok(r.ok, "indicator gaining a column broke validation");
});

check("numeric strings are coerced (Pine str.tostring output)", () => {
  const a = parsed({ score: "-67", spy: "770.45", legs_agree: "6" });
  eq(a.score, -67); eq(a.spy, 770.45); eq(a.legsAgree, 6);
});

console.log("\ndedupe identity");

check("dedupe key is strategy|bar_time|signal", () => {
  eq(dedupeKey(parsed({ signal: "ARM_PUT", action: "ARM" })),
     "SPY_CONVICTION|2026-08-12 09:50:00|ARM_PUT");
});

check("same bar, different signal is NOT a duplicate", () => {
  ok(dedupeKey(parsed({ signal: "ARM_PUT", action: "ARM" }))
     !== dedupeKey(parsed({ signal: "BUY_PUT", action: "BUY" })),
     "two signals on one bar collided");
});

console.log("\nnotification line");

check("format matches the Python reference exactly", () => {
  eq(formatAlert(parsed({ signal: "ARM_PUT", action: "ARM" })),
     "ARM_PUT | score -67 6/6 | vwap_reclaim @0.12 ATR | SPY 770.45 | 09:50");
});

check("no entry trigger falls back to the block reason", () => {
  const line = formatAlert(parsed({
    signal: "STAND_ASIDE", action: "FLAT", side: "NONE",
    entry_trigger: "none", block_reason: "chop_filter",
  }));
  ok(line.includes("chop_filter"), `expected the block reason in "${line}"`);
});

check("absent fields are dropped, never printed as null", () => {
  const body = { ...BASE, signal: "ARM_PUT", action: "ARM" };
  delete body.score; delete body.legs_agree; delete body.entry_trigger; delete body.spy;
  const r = parseConviction(JSON.stringify(body));
  ok(r.ok, "parse failed");
  eq(formatAlert(r.alert), "ARM_PUT | 09:50");
});

console.log("\nnotify gate");

check("ARM / BUY / REDUCE / SELL / CANCEL notify", () => {
  for (const a of ["ARM", "BUY", "REDUCE", "SELL", "CANCEL"]) {
    ok(NOTIFY_ACTIONS.has(a), `${a} should notify`);
  }
});

check("HOLD and FLAT stay silent", () => {
  ok(!NOTIFY_ACTIONS.has("HOLD"), "HOLD would fire all session");
  ok(!NOTIFY_ACTIONS.has("FLAT"), "FLAT would fire all session");
});

console.log("\nstate machine");

check("full PUT lifecycle, states and anomaly flags", () => {
  const steps = [
    ["ARM_PUT",    "ARMED_PUT"],
    ["BUY_PUT",    "LONG_PUT"],
    ["HOLD_PUT",   "LONG_PUT"],
    ["REDUCE_PUT", "LONG_PUT"],
    ["SELL_PUT",   "FLAT"],
  ];
  let state = "FLAT";
  for (const [signal, expect] of steps) {
    const t = applySignal(state, signal);
    eq(t.to, expect, `${signal} landed in the wrong state`);
    ok(!t.anomaly, `${signal} flagged unexpectedly: ${t.detail}`);
    state = t.to;
  }
});

check("full CALL lifecycle mirrors it", () => {
  let state = "FLAT";
  for (const [signal, expect] of [["ARM_CALL", "ARMED_CALL"], ["BUY_CALL", "LONG_CALL"], ["SELL_CALL", "FLAT"]]) {
    const t = applySignal(state, signal);
    eq(t.to, expect); ok(!t.anomaly, `${signal} flagged`);
    state = t.to;
  }
});

check("SELL while flat is flagged, not fatal", () => {
  const t = applySignal("FLAT", "SELL_CALL");
  ok(t.anomaly, "an impossible exit went unflagged");
  eq(t.to, "FLAT");
  ok(t.detail.includes("SELL_CALL"), "the detail should name the signal");
});

check("BUY without an ARM is flagged", () => {
  ok(applySignal("FLAT", "BUY_PUT").anomaly, "an unarmed entry went unflagged");
});

check("BUY_CALL while armed PUT is flagged", () => {
  const t = applySignal("ARMED_PUT", "BUY_CALL");
  ok(t.anomaly, "a side mismatch went unflagged");
  eq(t.to, "LONG_CALL", "we still follow the indicator");
});

check("ARM_CANCEL from armed is clean and lands flat", () => {
  const t = applySignal("ARMED_CALL", "ARM_CANCEL");
  ok(!t.anomaly, "a legal cancel was flagged");
  eq(t.to, "FLAT");
});

check("STAND_ASIDE while flat is the quiet heartbeat", () => {
  const t = applySignal("FLAT", "STAND_ASIDE");
  ok(!t.anomaly, "the idle heartbeat was flagged as an anomaly");
  eq(t.to, "FLAT");
});

check("STAND_ASIDE while long is flagged but still followed", () => {
  const t = applySignal("LONG_PUT", "STAND_ASIDE");
  ok(t.anomaly, "a missing exit went unflagged");
  eq(t.to, "FLAT", "the indicator is authoritative about its own state");
});

const total = pass + failures.length;
console.log(`\n${pass}/${total} passed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
