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
  classifyCross, planPrune, encodeLastCross, decodeLastCross, PRUNE_MIN_SWEPT,
  classifySlope, sessionDayStr,
} from "../dist/lib/avwapEarnings.js";
import {
  parseHist, encodeHist, appendHist, slopeFromHist, barsUntilSlope,
  BAR_SECONDS, HIST_MAX, HIST_TOLERANCE,
} from "../dist/lib/slopeHistory.js";

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

// Both directions, and the rule is SYMMETRIC. TOUCH_DOWN (AVWAP-only, "extended
// above then comes back and touches") was removed 2026-08-17 and replaced by a
// real CROSS_DOWN on every level. These assert the symmetry rather than silence:
// if one branch is ever changed without the other, they fail.

check("above -> below is a DOWN cross", cross(2.0, -0.5), "CROSS_DOWN");
check("above -> exactly at the level is a DOWN cross", cross(2.0, 0), "CROSS_DOWN");
check("above -> barely below is a DOWN cross", cross(0.9, -0.01), "CROSS_DOWN");
check("still above does not alert", cross(2.0, 0.4), "");

for (const [p, c] of [[-1.2, 0.8], [-0.9, 0.01], [-3, 0]]) {
  check(`symmetry: ${p} -> ${c} mirrors`, cross(-p, -c),
    cross(p, c) === "CROSS_UP" ? "CROSS_DOWN" : "");
}
check("only the two cross directions exist", new Set(
  [[-1, 1], [1, -1], [-1, -1], [1, 1], [-3, 0], [3, 0], [0.1, 0.2]]
    .map(([p, c]) => cross(p, c)).filter(Boolean),
), new Set(["CROSS_UP", "CROSS_DOWN"]));

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
// One bar can send a name UP through one level and DOWN through another, so the
// direction rides per level. Three older shapes are still in the table and must
// keep parsing — nothing was migrated.

check("one level", encodeLastCross([{ level: "sma50", dir: "CROSS_UP" }]),
  "sma50:CROSS_UP");
check("mixed directions in one bar",
  encodeLastCross([
    { level: "avwap", dir: "CROSS_UP" },
    { level: "sma50d", dir: "CROSS_DOWN" },
  ]),
  "avwap:CROSS_UP,sma50d:CROSS_DOWN");

check("round-trips",
  decodeLastCross(encodeLastCross([
    { level: "avwap", dir: "CROSS_UP" },
    { level: "sma50d", dir: "CROSS_DOWN" },
  ])),
  [{ level: "avwap", dir: "CROSS_UP" }, { level: "sma50d", dir: "CROSS_DOWN" }]);

// Legacy shapes.
check("legacy single level",
  decodeLastCross("sma50d:CROSS_UP"), [{ level: "sma50d", dir: "CROSS_UP" }]);
check("legacy multi-level, one trailing direction",
  decodeLastCross("avwap,sma50,ema21d:CROSS_UP"),
  [{ level: "avwap", dir: "CROSS_UP" },
   { level: "sma50", dir: "CROSS_UP" },
   { level: "ema21d", dir: "CROSS_UP" }]);
check("legacy TOUCH_DOWN still parses",
  decodeLastCross("avwap:TOUCH_DOWN"), [{ level: "avwap", dir: "TOUCH_DOWN" }]);
check("empty", decodeLastCross(""), []);
check("a bare level with no direction anywhere is dropped, not guessed",
  decodeLastCross("avwap"), []);

// ── ───────────────────────────────────────────────────────────────────────────
// -- Level slope ---------------------------------------------------------------
// Which way the LINE is pointing, not where price sits against it. The deadband
// exists so a flat 5-day average does not flip UP/DOWN on rounding noise, which
// would make the "above and rising" count unusable.
const SLOPE_MIN = 0.10;
const slope = (v) => classifySlope(v, SLOPE_MIN);

check("clearly rising", slope(0.8), "UP");
check("clearly falling", slope(-0.8), "DOWN");
check("exactly at the threshold counts as rising", slope(0.10), "UP");
check("exactly at the negative threshold counts as falling", slope(-0.10), "DOWN");
check("inside the deadband is flat, not up", slope(0.09), "FLAT");
check("inside the deadband is flat, not down", slope(-0.09), "FLAT");
check("dead flat is flat", slope(0), "FLAT");

// Symmetric, exactly like classifyCross - if one branch moves, so must the other.
check("slope is symmetric", slope(0.42) === "UP" && slope(-0.42) === "DOWN", true);

// A missing slope is NOT flat. A young symbol with no history behind the level
// has an unknown trend, and folding that into FLAT would quietly count it as
// "not rising" in a metric whose whole job is to separate rising from falling.
check("null slope is unknown", slope(null), "");
check("undefined slope is unknown", slope(undefined), "");
check("NaN slope is unknown", slope(NaN), "");
check("Infinity slope is unknown", slope(Infinity), "");

// -- Session day ----------------------------------------------------------------
// The crossing matrix must roll at the OPEN, not at midnight, or it blanks from
// 21:00 PT through the whole premarket - exactly when the last session's
// crossings are worth reviewing.
const at = (iso) => sessionDayStr(new Date(iso));

// 2026-08-25 is a Tuesday. 13:30Z = 09:30 ET (EDT), the open.
check("just before the open still belongs to the previous session",
  at("2026-08-25T13:29:00Z"), "2026-08-24");
check("the open rolls the session",
  at("2026-08-25T13:30:00Z"), "2026-08-25");
check("midday is the current session", at("2026-08-25T17:00:00Z"), "2026-08-25");
check("after the close is still the current session",
  at("2026-08-25T20:30:00Z"), "2026-08-25");

// The bug this replaces: at 21:00 PT the ET date has already rolled to the 26th,
// so the old key read an empty partition and every count went to zero.
check("21:00 PT (past ET midnight) still shows that day's session",
  at("2026-08-26T04:00:00Z"), "2026-08-25");
check("premarket next morning still shows the previous session",
  at("2026-08-26T12:00:00Z"), "2026-08-25");

// -- Slope history ---------------------------------------------------------
// The fallback that lets the slope be DERIVED from values we already receive,
// instead of waiting on the publisher to send a new field. The whole point is
// that it must never fabricate a slope it cannot actually support.

const B = BAR_SECONDS;                 // 39 minutes
const T0 = 1787947200;                 // an arbitrary bar time
const pt = (t, sma) => ({ t, v: { avwap: 1, sma50: sma, ema21d: 2, sma50d: 3 } });

check("bar seconds is 39 minutes", BAR_SECONDS, 2340);

// Round-trip. Nulls survive as nulls rather than becoming zeros.
check("encode/parse round-trips a value",
  parseHist(encodeHist([pt(T0, 75.5)]))[0].v.sma50, 75.5);
check("a missing level stays null through a round trip",
  parseHist(encodeHist([{ t: T0, v: { avwap: 1, sma50: null, ema21d: 2, sma50d: 3 } }]))[0].v.sma50, null);
check("empty history parses to nothing", parseHist(""), []);
check("garbage parses to nothing, it does not throw", parseHist("not-a-history"), []);
check("null input", parseHist(null), []);

// One entry per bar. Re-scoring a bar must REPLACE it: two entries for one bar
// would consume two slots and silently shorten the lookback window.
{
  let h = [];
  h = appendHist(h, pt(T0, 10));
  h = appendHist(h, pt(T0, 11));
  check("re-scoring the same bar replaces, never appends", h.length, 1);
  check("and keeps the newer value", h[0].v.sma50, 11);
}
{
  let h = [];
  for (let i = 0; i < HIST_MAX + 6; i++) h = appendHist(h, pt(T0 + i * B, i));
  check("history is trimmed to its cap", h.length, HIST_MAX);
  check("and it is the NEWEST that survive", h[h.length - 1].v.sma50, HIST_MAX + 5);
}
check("a bar with no time cannot enter the history",
  appendHist([pt(T0, 1)], { t: 0, v: { sma50: 9 } }).length, 1);

// The slope itself.
{
  const h = [];
  for (let i = 0; i < 20; i++) h.push(pt(T0 + i * B, 100 * Math.pow(1.002, i)));
  const now = T0 + 20 * B;
  const nowVal = 100 * Math.pow(1.002, 20);
  // 15 bars back from bar 20 is bar 5. 1.002^15 - 1 = 3.0421%.
  // 1.002^15 = 1.0304238. Note the derived path rounds to 4dp where the
  // published path (chart_js.mjs) rounds to 3 — both display at 2dp, so they
  // agree everywhere the operator can see.
  check("derives the exact 15-bar slope",
    slopeFromHist(h, "sma50", now, nowVal, 15), 3.0424);
  check("a shorter lookback gives a smaller slope",
    slopeFromHist(h, "sma50", now, nowVal, 10) < slopeFromHist(h, "sma50", now, nowVal, 15), true);
  // This is the number the published path produced for the same ramp, so the
  // two sources agree on what "the slope" means.
  check("10-bar matches the published path's value",
    slopeFromHist(h, "sma50", now, nowVal, 10), 2.0181);
}

// NOT ENOUGH HISTORY IS NULL. During the warm-up the honest answer is "unknown",
// never a slope measured over whatever short window happens to exist.
{
  const h = [pt(T0, 100), pt(T0 + B, 101)];
  check("too little history -> null, not a short-window slope",
    slopeFromHist(h, "sma50", T0 + 2 * B, 102, 15), null);
  check("warm-up remaining is reported", barsUntilSlope(h, 15), 13);
  check("warm-up is zero once covered", barsUntilSlope(new Array(15).fill(pt(T0, 1)), 15), 0);
}

// THE RULE THAT MATTERS. A gap must not be bridged by counting entries: doing so
// measures a longer window than asked for while reporting the asked-for one.
{
  const h = [];
  for (let i = 0; i < 20; i++) {
    if (i >= 4 && i <= 9) continue;           // six bars missing where 15-back lands
    h.push(pt(T0 + i * B, 100 + i));
  }
  check("a gap over the target bar yields null, not the nearest survivor",
    slopeFromHist(h, "sma50", T0 + 20 * B, 130, 15), null);
}
// Just inside tolerance is still accepted - a bar half a period off IS the bar.
{
  const h = [pt(T0 + 5 * B + Math.floor(B * (HIST_TOLERANCE - 0.05)), 100)];
  check("a bar just inside tolerance is used",
    slopeFromHist(h, "sma50", T0 + 20 * B, 110, 15) !== null, true);
}
{
  const h = [pt(T0 + 5 * B + Math.ceil(B * (HIST_TOLERANCE + 0.05)), 100)];
  check("a bar just outside tolerance is not",
    slopeFromHist(h, "sma50", T0 + 20 * B, 110, 15), null);
}

// Never look forward, and never divide by a level that was not there.
{
  const h = [pt(T0 + 30 * B, 100)];
  check("future bars are ignored", slopeFromHist(h, "sma50", T0 + 20 * B, 110, 15), null);
}
{
  const h = [{ t: T0 + 5 * B, v: { sma50: null } }];
  check("a null level at the far end -> null",
    slopeFromHist(h, "sma50", T0 + 20 * B, 110, 15), null);
}
{
  const h = [pt(T0 + 5 * B, 0)];
  check("a zero level cannot be a denominator",
    slopeFromHist(h, "sma50", T0 + 20 * B, 110, 15), null);
}
check("no current value -> null", slopeFromHist([pt(T0, 100)], "sma50", T0 + 15 * B, null, 15), null);
check("a flat line derives exactly zero",
  slopeFromHist([pt(T0, 100)], "sma50", T0 + 15 * B, 100, 15), 0);

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${pass + failures.length}\n`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`PASS — ${pass} assertions (alert rule + roster prune + slope + session day + slope history)`);
