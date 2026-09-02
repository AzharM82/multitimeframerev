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
  BAR_SECONDS, HIST_MAX, GAP_TOLERANCE,
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
// instead of waiting on the publisher to send a new field.
//
// EVERY case below uses REALISTIC bar times: ten 39-minute bars per session,
// then an overnight gap. The first version of this suite generated a continuous
// ramp (T0 + i*BAR) with no session breaks, and that is exactly why it passed a
// build that could never produce a slope in production - see the session-gap
// assertions below.

const B = BAR_SECONDS;
const SESSION_BARS = 10;                       // 390-minute session / 39
/** 09:30 ET on the Nth weekday from Mon 2026-08-31, as epoch seconds. */
const openOf = (day) => Date.UTC(2026, 7, 31 + day, 13, 30, 0) / 1000;
const barAt = (day, bar) => openOf(day) + bar * B;

/** `days` sessions of real bars, the level compounding `step` each bar. */
function realHistory(days, step = 0.002, from = 100) {
  const h = []; let v = from;
  for (let d = 0; d < days; d++) {
    for (let b = 0; b < SESSION_BARS; b++) { h.push({ t: barAt(d, b), v: { sma50: v } }); v *= 1 + step; }
  }
  return { hist: h, next: v };
}

check("bar seconds is 39 minutes", BAR_SECONDS, 2340);
check("a session is ten bars", SESSION_BARS * B, 390 * 60);

// Round-trip. Nulls survive as nulls rather than becoming zeros.
check("encode/parse round-trips a value",
  parseHist(encodeHist([{ t: barAt(0, 0), v: { avwap: 1, sma50: 75.5, ema21d: 2, sma50d: 3 } }]))[0].v.sma50, 75.5);
check("a missing level stays null through a round trip",
  parseHist(encodeHist([{ t: barAt(0, 0), v: { avwap: 1, sma50: null, ema21d: 2, sma50d: 3 } }]))[0].v.sma50, null);
check("empty history parses to nothing", parseHist(""), []);
check("garbage parses to nothing, it does not throw", parseHist("not-a-history"), []);
check("null input", parseHist(null), []);

// One entry per bar. Re-scoring a bar must REPLACE it: two entries for one bar
// would consume two slots and silently shorten the lookback window.
{
  let h = [];
  h = appendHist(h, { t: barAt(0, 0), v: { sma50: 10 } });
  h = appendHist(h, { t: barAt(0, 0), v: { sma50: 11 } });
  check("re-scoring the same bar replaces, never appends", h.length, 1);
  check("and keeps the newer value", h[0].v.sma50, 11);
}
{
  let h = [];
  const { hist } = realHistory(4);
  for (const pt of hist) h = appendHist(h, pt);
  check("history is trimmed to its cap", h.length, HIST_MAX);
  check("and it is the NEWEST that survive", h[h.length - 1].t, barAt(3, SESSION_BARS - 1));
}
check("a bar with no time cannot enter the history",
  appendHist([{ t: barAt(0, 0), v: { sma50: 1 } }], { t: 0, v: { sma50: 9 } }).length, 1);

// THE BUG THIS SUITE MISSED THE FIRST TIME.
// A session is ten bars, so a 15-bar lookback ALWAYS crosses a night. Matching
// on `now - 15 * 39min` lands at ~02:37 in the morning where no bar exists, and
// returns null forever. The lookback must be counted in BARS, walking the
// stored sequence, which skips nights on its own.
{
  const { hist, next } = realHistory(2);          // 20 bars over two sessions
  const now = barAt(2, 0);                        // first bar of the third day
  check("two sessions of real bars is 20", hist.length, 20);
  const got = slopeFromHist(hist, "sma50", now, next, 15);
  check("a 15-bar slope RESOLVES across an overnight gap", got !== null, true);
  // 15 bars of 1.002 compounding = 3.0424%. Same number the published path gives.
  check("and it is the exact 15-bar ramp", got, 3.0424);
}
{
  const { hist, next } = realHistory(3);          // spans two nights
  check("a 25-bar lookback spanning TWO nights also resolves",
    slopeFromHist(hist, "sma50", barAt(3, 0), next, 25) !== null, true);
}
// A weekend is just a longer gap on a different ET day - same rule, no special case.
{
  const h = [], step = 0.002; let v = 100;
  for (const d of [0, 1, 2, 3, 4, 7, 8]) {        // Mon-Fri, then Mon-Tue
    for (let b = 0; b < SESSION_BARS; b++) { h.push({ t: barAt(d, b), v: { sma50: v } }); v *= 1 + step; }
  }
  check("a lookback spanning a WEEKEND resolves",
    slopeFromHist(h, "sma50", barAt(9, 0), v, 15) !== null, true);
}

// Warm-up. Fewer bars than the lookback is unknown, never a short-window slope.
{
  const { hist, next } = realHistory(1);          // 10 bars, one session
  check("too little history -> null, not a short-window slope",
    slopeFromHist(hist, "sma50", barAt(1, 0), next, 15), null);
  check("warm-up remaining is reported", barsUntilSlope(hist, 15), 5);
  check("warm-up is zero once covered", barsUntilSlope(realHistory(2).hist, 15), 0);
}

// A HOLE INSIDE A SESSION still invalidates the window. Counting entries through
// a missed sweep would measure a longer span than asked for while reporting the
// asked-for one - which is why the clock check existed at all.
{
  const { hist, next } = realHistory(2);
  const holed = hist.filter((p) => p.t !== barAt(1, 3));   // drop one mid-session bar
  check("a missed sweep inside the window -> null",
    slopeFromHist(holed, "sma50", barAt(2, 0), next, 15), null);
}
{
  // The same hole, but OUTSIDE the 15-bar window, must not matter.
  const { hist, next } = realHistory(3);
  const holed = hist.filter((p) => p.t !== barAt(0, 3));   // day 0 is long past
  check("a hole outside the window is irrelevant",
    slopeFromHist(holed, "sma50", barAt(3, 0), next, 15) !== null, true);
}

// Never look forward, and never divide by a level that was not there.
check("future bars are ignored",
  slopeFromHist([{ t: barAt(5, 0), v: { sma50: 100 } }], "sma50", barAt(2, 0), 110, 15), null);
{
  const { hist, next } = realHistory(2);
  hist[hist.length - 15].v.sma50 = null;
  check("a null level at the far end -> null", slopeFromHist(hist, "sma50", barAt(2, 0), next, 15), null);
}
{
  const { hist, next } = realHistory(2);
  hist[hist.length - 15].v.sma50 = 0;
  check("a zero level cannot be a denominator", slopeFromHist(hist, "sma50", barAt(2, 0), next, 15), null);
}
check("no current value -> null", slopeFromHist(realHistory(2).hist, "sma50", barAt(2, 0), null, 15), null);
{
  const flat = realHistory(2, 0);                 // no movement at all
  check("a flat line derives exactly zero",
    slopeFromHist(flat.hist, "sma50", barAt(2, 0), flat.next, 15), 0);
}
{
  const { hist, next } = realHistory(2, -0.002);
  check("a falling line derives a negative slope",
    slopeFromHist(hist, "sma50", barAt(2, 0), next, 15) < 0, true);
}
check("gap tolerance", GAP_TOLERANCE, 1.5);

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${pass + failures.length}\n`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`PASS — ${pass} assertions (alert rule + roster prune + slope + session day + slope history)`);
