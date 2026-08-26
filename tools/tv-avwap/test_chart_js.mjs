#!/usr/bin/env node
/**
 * Offline test of the REAL page-context code.
 *
 * Run:  node test_chart_js.mjs        (exit 0 = pass)
 *
 * WHY THIS EXISTS. A rewrite once deleted `__avwResolve` outright while leaving
 * `__avwResolveReport` calling it. Nothing caught it: the unit tests exercised a
 * hand-copied parser, and the "live chart" check pasted a hand-written
 * equivalent into the page instead of the file's own INSTALL. Both validated
 * logic that was never the shipped artifact, and the broken build reached main.
 *
 * So this evaluates the actual `INSTALL` string exported by chart_js.mjs, in a
 * stubbed `window`, against a fake chart built from the REAL study titles and
 * REAL value arrays read off yaYerb4T. If a helper is missing, unwired, or reads
 * the wrong plot, this fails - without a browser, and without trusting anything
 * that might still be resident in a page.
 */

import { INSTALL, INSTALL_VERSION, jsPreflight, jsSweep, jsWatchlist } from "./chart_js.mjs";

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${got}, want ${want}`);

// ── A fake chart, built from what the live layout actually reports ──────────
// Titles and value arrays are verbatim from yaYerb4T / MXL at bar
// 2026-08-14T19:21:00Z (close 84.96), cross-checked by DESKTOP2 over CDP.
const BAR = 1786735260, PREV = BAR - 39 * 60, PREV2 = BAR - 78 * 60;

function series(title, rows) {
  return {
    title: () => title,
    data: () => ({
      lastIndex: () => rows.length - 1,
      valueAt: (i) => rows[i],
    }),
  };
}
function priceSeries(title, bars) {
  return {
    title: () => title,
    data: () => ({ bars: () => ({ lastIndex: () => bars.length - 1, valueAt: (i) => bars[i] }) }),
  };
}

const VWAP_T = "VWAP AA (Earnings, ohlc4, 14, Percentage, true, 1, false, 2, false, 3)";
const SMA_T = "SMA (50, ohlc4, 0, None, 65, 0.001, true, false, false)";
const HTF_T = "Moving Averages HTF (false, true, EMA, ohlc4, 10, 1D, 1, rgba(0, 0, 0, 1), " +
  "true, true, EMA, ohlc4, 21, 1D, 1, rgba(41, 98, 255, 1), " +
  "true, true, SMA, ohlc4, 50, 1D, 1, #0000FF, " +
  "false, false, EMA, close, 100, , 1, #0000FF)";

const AVWAP = 69.30305109562687, SMA50 = 75.11702499999994;
const EMA21D = 75.00912047586905, SMA50D = 82.735196;

function makeChart({ closes = [70, 74, 84.96] } = {}) {
  const times = [PREV2, PREV, BAR];
  const bars = times.map((t, i) => [t, closes[i], closes[i], closes[i], closes[i], 1000]);
  const vwapRows = times.map((t) => [t, AVWAP, AVWAP * 1.01, AVWAP * 0.99, null, null, null, null]);
  const smaRows = times.map((t) => [t, SMA50, null, null, null, null]);
  // plot_0 null (slot1 disabled), plot_2 = EMA21 1D, plot_4 = SMA50 1D.
  //
  // HIGHER-TIMEFRAME PLOTS ARE SPARSE, and this is the real shape: a daily
  // value lands on the bar at the day boundary and every later 39m bar inside
  // that day is null. DESKTOP2 read exactly this off AVGO. Requiring a value on
  // both scored bars rejected every symbol (Swept 0/193, exit 6), which is why
  // the fake models the sparsity rather than a convenient dense series.
  const htfRows = times.map((t, i) => (i === 0
    ? [t, null, 0, EMA21D, 1, SMA50D, 2, null, 3, null, 4]
    : [t, null, 0, null, 1, null, 2, null, 3, null, 4]));
  return [
    priceSeries("MXL · BATS, 39", bars),
    series(VWAP_T, vwapRows),
    series(SMA_T, smaRows),
    series(HTF_T, htfRows),
  ];
}

// ── Evaluate the REAL INSTALL in a stubbed window ───────────────────────────
const win = {};
let sources = makeChart();
win._exposed_chartWidgetCollection = {
  activeChartWidget: { value: () => ({ model: () => ({ model: () => ({ dataSources: () => sources }) }) }) },
};
globalThis.window = win;
// Deliberately NOT provided: getInputValues on any source. That is exactly the
// TradingView Desktop 3.3.0.0 condition that broke the previous build - the
// title path must carry the whole job on its own.

const installResult = (0, eval)(INSTALL);
eq("INSTALL returns 'ok'", installResult, "ok");

console.log("\n--- every helper INSTALL promises is actually defined ---");
for (const fn of ["__avwSleep", "__avwSources", "__avwTitleArgs", "__avwResolve",
                  "__avwResolveReport", "__avwRead", "__avwOne"]) {
  ok(`${fn} is a function`, typeof win[fn] === "function", `(${typeof win[fn]})`);
}
eq("__avwVersion matches INSTALL_VERSION", win.__avwVersion, INSTALL_VERSION);

console.log("\n--- resolution, with NO getInputValues available ---");
const r = win.__avwResolve();
ok("no resolution errors", r.errors.length === 0, JSON.stringify(r.errors));
eq("avwap  valueIdx", r.levels.avwap?.valueIdx, 1);
eq("sma50  valueIdx", r.levels.sma50?.valueIdx, 1);
eq("ema21d valueIdx (slot 2 -> plot_2)", r.levels.ema21d?.valueIdx, 3);
eq("sma50d valueIdx (slot 3 -> plot_4)", r.levels.sma50d?.valueIdx, 5);

const rep = win.__avwResolveReport();
eq("report: avwap value", rep.levels.avwap.lastValue, AVWAP);
eq("report: sma50 value", rep.levels.sma50.lastValue, SMA50);
eq("report: ema21d value", rep.levels.ema21d.lastValue, EMA21D);
eq("report: sma50d value", rep.levels.sma50d.lastValue, SMA50D);

console.log("\n--- __avwRead on a CLOSED last bar ---");
const realNow = Date.now;
Date.now = () => (BAR + 39 * 60 + 5) * 1000;      // last bar has elapsed
const read = win.__avwRead("MXL", 39 * 60);
ok("read returned a row", read && !read.fatal, JSON.stringify(read?.fatal || ""));
eq("lastBarClosed", read?.lastBarClosed, true);
eq("closedTime is the last bar", read?.closedTime, BAR);
eq("prevTime is the one before", read?.prevTime, PREV);
eq("close", read?.close, 84.96);
const pctOf = (v) => +(((84.96 - v) / v) * 100).toFixed(2);
eq("pct avwap", read?.levels.avwap.pct, pctOf(AVWAP));
eq("pct sma50", read?.levels.sma50.pct, pctOf(SMA50));
eq("pct ema21d", read?.levels.ema21d.pct, pctOf(EMA21D));
eq("pct sma50d", read?.levels.sma50d.pct, pctOf(SMA50D));
// prev candle closed at 74, below every level -> the cross-up precondition
ok("prev-candle pct uses the PREVIOUS bar's close",
   read?.levels.sma50d.pPct === +(((74 - SMA50D) / SMA50D) * 100).toFixed(2));

console.log("\n--- __avwRead while the last bar is still FORMING ---");
Date.now = () => (BAR + 60) * 1000;               // 1 min into the bar
const forming = win.__avwRead("MXL", 39 * 60);
eq("lastBarClosed", forming?.lastBarClosed, false);
eq("scores the PREVIOUS bar as closed", forming?.closedTime, PREV);
eq("live close is still the forming bar", forming?.close, 84.96);
Date.now = realNow;

console.log("\n--- fails CLOSED when the chart is wrong ---");
sources = makeChart().filter((s) => !/^SMA \(/.test(s.title()));
const missing = win.__avwResolve();
ok("missing SMA study is an error", missing.errors.some((e) => /standalone SMA/.test(e)));
const fatal = win.__avwRead("MXL", 39 * 60);
ok("__avwRead reports fatal rather than a plausible row", Array.isArray(fatal?.fatal));

sources = makeChart();
sources[1] = series(VWAP_T.replace("Earnings", "Session"), [[BAR, AVWAP, 0, 0, null, null, null, null]]);
ok("wrong VWAP anchor is an error",
   win.__avwResolve().errors.some((e) => /anchor is "Session"/.test(e)));

sources = makeChart();
sources[3] = series(HTF_T.replace("true, true, EMA, ohlc4, 21, 1D", "false, true, EMA, ohlc4, 21, 1D"),
                    [[BAR, null, 0, EMA21D, 1, SMA50D, 2]]);
ok("disabled EMA21 slot is an error",
   win.__avwResolve().errors.some((e) => /EMA 21 1D/.test(e)));

console.log("");
console.log("--- carry-forward: the exit-6 blocker ---");
sources = makeChart();   // earlier fail-closed cases left `sources` mutated
// The fake chart above carries daily values ONLY on bar 0; both scored bars are
// null. Every assertion in the CLOSED-bar section above therefore already
// depends on carry-forward - without it they return null, which is exactly the
// Swept 0/193 failure. These make the intent explicit.
Date.now = () => (BAR + 39 * 60 + 5) * 1000;
const sparse = win.__avwRead("MXL", 39 * 60);
ok("sparse daily plots no longer reject the symbol", sparse && !sparse.fatal);
eq("ema21d carried to the scored bar", sparse?.levels.ema21d.value, EMA21D);
eq("sma50d carried to the scored bar", sparse?.levels.sma50d.value, SMA50D);
ok("cross-up is expressible again (prev below, last above)",
   sparse.levels.sma50d.pPct < 0 && sparse.levels.sma50d.cPct > 0);

console.log("");
console.log("--- a level with NO value anywhere degrades per-LEVEL, not per-symbol ---");
sources = makeChart();
sources[3] = series(HTF_T, [PREV2, PREV, BAR].map((t) => [t, null, 0, null, 1, null, 2]));
const partial = win.__avwRead("MXL", 39 * 60);
ok("symbol still publishes", partial && !partial.fatal);
eq("avwap still present", partial?.levels.avwap.value, AVWAP);
eq("sma50 still present", partial?.levels.sma50.value, SMA50);
eq("ema21d degrades to null", partial?.levels.ema21d.value, null);
ok("a null level cannot alert", partial?.levels.sma50d.pPct === null && partial?.levels.sma50d.cPct === null);

console.log("");
console.log("--- but a missing AVWAP still rejects the whole symbol ---");
sources = makeChart();
sources[1] = series(VWAP_T, [PREV2, PREV, BAR].map((t) => [t, null, null, null, null, null, null, null]));
ok("no AVWAP anywhere -> symbol rejected", win.__avwRead("MXL", 39 * 60) === null);
Date.now = realNow;
sources = makeChart();

console.log("\n--- expression builders still produce valid JS ---");
for (const [name, src] of [["jsPreflight", jsPreflight("39")],
                           ["jsWatchlist", jsWatchlist("MASTER")],
                           ["jsSweep", jsSweep(["NASDAQ:MXL"], 12000, 2340)]]) {
  let good = true;
  try { new Function(`return ${src}`); } catch (e) { good = false; console.log("   " + e.message); }
  ok(`${name} parses`, good);
}

console.log("");
console.log("--- slope of the LEVEL itself (the trend metric) ---");

/**
 * A chart `n` bars long where the 5-day SMA moves `stepPct` per bar. The daily
 * levels stay SPARSE - a value only on bar 0 - because that is the real shape
 * and the slope has to stay correct through carryBack, not just on dense data.
 */
function makeRamp(n, stepPct) {
  const times = Array.from({ length: n }, (_, i) => BAR - (n - 1 - i) * 39 * 60);
  const bars = times.map((t) => [t, 84.96, 84.96, 84.96, 84.96, 1000]);
  const smaAt = (i) => SMA50 * Math.pow(1 + stepPct / 100, i);
  return {
    times,
    smaAt,
    sources: [
      priceSeries("MXL · BATS, 39", bars),
      series(VWAP_T, times.map((t) => [t, AVWAP, AVWAP * 1.01, AVWAP * 0.99, null, null, null, null])),
      series(SMA_T, times.map((t, i) => [t, smaAt(i), null, null, null, null])),
      series(HTF_T, times.map((t, i) => (i === 0
        ? [t, null, 0, EMA21D, 1, SMA50D, 2, null, 3, null, 4]
        : [t, null, 0, null, 1, null, 2, null, 3, null, 4]))),
    ],
  };
}

// The last bar is CLOSED for these, so the scored bar ci === li.
const realNow2 = Date.now;
Date.now = () => (BAR + 39 * 60) * 1000;

// 30 bars, +0.20%/bar. Over a 15-bar lookback the line is up 1.015^... exactly
// (1.002^15 - 1) * 100 = 3.0421%. Asserting the NUMBER, not just the sign:
// a sign-only test passes just as happily with an off-by-one lookback.
{
  const ramp = makeRamp(30, 0.20);
  sources = ramp.sources;
  const r = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 15);
  const want = +(((ramp.smaAt(29) - ramp.smaAt(14)) / ramp.smaAt(14)) * 100).toFixed(3);
  eq("rising 5D SMA reports the exact 15-bar slope", r?.levels.sma50.slope, want);
  ok("rising slope is positive", r?.levels.sma50.slope > 0);
}

// Symmetry. Same magnitude of step down must report the mirror sign.
{
  const ramp = makeRamp(30, -0.20);
  sources = ramp.sources;
  const r = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 15);
  ok("falling 5D SMA reports a negative slope", r?.levels.sma50.slope < 0);
}

// A dead-flat line must read exactly zero, not a rounding artefact - the
// deadband downstream depends on this being clean.
{
  const ramp = makeRamp(30, 0);
  sources = ramp.sources;
  const r = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 15);
  eq("a flat line reports exactly zero slope", r?.levels.sma50.slope, 0);
}

// The lookback is honoured, not hardcoded. 10 bars of the same ramp must give a
// SMALLER slope than 15 - this is what catches TV_SLOPE_BARS being ignored.
{
  const ramp = makeRamp(30, 0.20);
  sources = ramp.sources;
  const a = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 10);
  const b = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 15);
  ok("a shorter lookback yields a smaller slope",
     a?.levels.sma50.slope > 0 && a.levels.sma50.slope < b.levels.sma50.slope);
  const want10 = +(((ramp.smaAt(29) - ramp.smaAt(19)) / ramp.smaAt(19)) * 100).toFixed(3);
  eq("10-bar lookback steps back exactly 10 bars", a?.levels.sma50.slope, want10);
}

// NOT ENOUGH HISTORY IS NULL, NOT ZERO. A young symbol has an unknown trend;
// reporting 0 would fold it into FLAT and quietly count it as "not rising".
{
  const ramp = makeRamp(8, 0.20);
  sources = ramp.sources;
  const r = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 15);
  eq("too little history -> null slope, never 0", r?.levels.sma50.slope, null);
  ok("the row still publishes its levels", r?.levels.sma50.value > 0);
}

// A SPARSE daily line is flat across the bars it spans, so its slope over a
// window inside one day is genuinely 0 - carryBack must produce that, not null.
{
  const ramp = makeRamp(30, 0.20);
  sources = ramp.sources;
  const r = win.__avwRead("MXL", 39 * 60, "BATS:MXL", 15);
  eq("a sparse daily level carries back to a real slope", r?.levels.sma50d.slope, 0);
  ok("a sparse daily level is not null", r?.levels.sma50d.slope !== null);
}

Date.now = realNow2;
sources = makeChart();

console.log("");
console.log(failures ? `RESULT: ${failures} FAILURE(S)` : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
