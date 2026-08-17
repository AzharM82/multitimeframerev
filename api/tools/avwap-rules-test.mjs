/**
 * Unit tests for the two AVWAP rules that run unattended: what alerts, and what
 * gets deleted. Run against the COMPILED output, for the reason recorded in
 * tools/tv-avwap/test_chart_js.mjs — a test that exercises a hand-copied version
 * of the logic passes happily while the shipped artefact is broken.
 *
 *   cd api && npm run build && node tools/avwap-rules-test.mjs
 *
 * No Azure, no network, no storage: both functions under test are pure.
 */
import {
  classifyCross, planPrune, encodeLastCross, PRUNE_MIN_SWEPT,
} from "../dist/lib/avwapEarnings.js";

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

const MIN = 0.25;
const cross = (prev, now) => classifyCross(prev, now, MIN);

// ── The alert rule ────────────────────────────────────────────────────────────
// Previous closed candle below the level, latest closed candle at or above it.
// That is the whole rule, for every level.

check("below -> above alerts", cross(-1.2, 0.8), "CROSS_UP");
check("below -> exactly at the level alerts", cross(-1.2, 0), "CROSS_UP");
check("below -> barely above alerts", cross(-0.9, 0.01), "CROSS_UP");
check("still below does not alert", cross(-1.2, -0.4), "");
check("already above stays quiet", cross(1.2, 2.4), "");

// The 2026-08-17 removal of TOUCH_DOWN. These four are the regression guard:
// if a second direction is ever reintroduced, they fail.
check("above -> below is SILENT (was TOUCH_DOWN)", cross(2.0, -0.5), "");
check("above -> exactly at the level is SILENT", cross(2.0, 0), "");
check("above -> far below is SILENT", cross(5.0, -3.0), "");
check("no direction other than CROSS_UP exists", new Set(
  [[-1, 1], [1, -1], [-1, -1], [1, 1], [-3, 0], [3, 0]]
    .map(([p, c]) => cross(p, c)).filter(Boolean),
).size <= 1, true);

// Deadband — on the PREVIOUS candle only.
check("prev sitting on the level does not alert", cross(-0.1, 0.4), "");
check("prev just inside the deadband does not alert", cross(-0.249, 1.0), "");
check("prev exactly at the deadband alerts", cross(-0.25, 0.1), "CROSS_UP");
check("deadband does not apply to the current candle", cross(-1.0, 0.001), "CROSS_UP");
check("deadband is configurable", classifyCross(-0.3, 0.2, 0.5), "");

// Missing data must never be read as a crossing.
check("null prev", cross(null, 1.0), "");
check("null current", cross(-1.0, null), "");
check("undefined prev", cross(undefined, 1.0), "");
check("NaN", cross(NaN, 1.0), "");
check("Infinity", cross(-Infinity, 1.0), "");

// ── The prune rule ────────────────────────────────────────────────────────────
// `current` must equal the MASTER roster = swept ∪ failed.

const roster = Array.from({ length: 60 }, (_, i) => `SYM${i}`);

check("a symbol still in MASTER is kept",
  planPrune(roster, roster, []).prune, []);

check("a symbol that left MASTER is pruned",
  planPrune([...roster, "KXIAY"], roster, []).prune, ["KXIAY"]);

check("a symbol that merely FAILED to read is kept",
  planPrune([...roster, "THIN"], roster, ["THIN"]).prune, []);

check("failed symbols count toward the roster, exchange-qualified or not",
  planPrune([...roster, "THIN"], roster, ["NASDAQ:THIN"]).prune, []);

check("ticker matching is case-insensitive",
  planPrune([...roster, "kxiay"], [...roster, "KXIAY"], []).prune, []);

check("__meta__ is never pruned",
  planPrune([...roster, "__meta__"], roster, []).prune, []);

// The guards. Deleting is the only destructive thing this endpoint does, and it
// runs every 39 minutes with nobody watching.
check("a tiny sweep prunes nothing",
  planPrune(roster, roster.slice(0, PRUNE_MIN_SWEPT - 1), []).prune, []);
check("a tiny sweep says why",
  planPrune(roster, roster.slice(0, 3), []).heldBack, "only 3 symbols swept");
check("an empty sweep prunes nothing",
  planPrune(roster, [], []).prune, []);

// Big enough that the row-count guard is satisfied and the FAILED-fraction
// guard is the one under test — otherwise this branch never runs.
const wide = Array.from({ length: 100 }, (_, i) => `W${i}`);
const readOk = wide.slice(0, 70);
const cannotRead = wide.slice(70);          // 30/100 = 30% > 25%
check("a sweep failing >25% prunes nothing",
  planPrune([...wide, "GONE"], readOk, cannotRead).prune, []);
check("a sweep failing >25% says why",
  planPrune(wide, readOk, cannotRead).heldBack, "30/100 symbols failed to read");
check("a sweep failing just under 25% still prunes",
  planPrune([...wide, "GONE"], wide.slice(0, 76), wide.slice(76)).prune, ["GONE"]);
check("a healthy sweep with a few failures still prunes",
  planPrune([...roster, "GONE"], roster.slice(0, 55), roster.slice(55)).prune, ["GONE"]);

check("a healthy sweep reports no hold-back",
  planPrune(roster, roster, []).heldBack, "");

// ── lastCross encoding ────────────────────────────────────────────────────────
// The tab reads this to say WHICH levels were cleared. It used to hold one
// level chosen by loop order, so a name clearing three showed one.

check("a single level encodes to the old shape",
  encodeLastCross(["sma50"], "CROSS_UP"), "sma50:CROSS_UP");
check("several levels ride in one value",
  encodeLastCross(["ema21d", "sma50", "sma50d"], "CROSS_UP"),
  "ema21d,sma50,sma50d:CROSS_UP");

// The frontend's parse, mirrored — split on ":" then ",". Both shapes, plus the
// TOUCH_DOWN rows still sitting in the table from before 2026-08-17.
const parse = (s) => {
  const [csv, dir] = s.split(":");
  return { levels: csv.split(",").filter(Boolean), dir };
};
check("round-trips", parse(encodeLastCross(["avwap", "sma50d"], "CROSS_UP")),
  { levels: ["avwap", "sma50d"], dir: "CROSS_UP" });
check("a row from the OLD build still parses",
  parse("sma50d:CROSS_UP"), { levels: ["sma50d"], dir: "CROSS_UP" });
check("a historical TOUCH_DOWN row still parses",
  parse("avwap:TOUCH_DOWN"), { levels: ["avwap"], dir: "TOUCH_DOWN" });

// ── ───────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${pass + failures.length}\n`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`PASS — ${pass} assertions (alert rule + roster prune)`);
