/**
 * Unit checks for the Swing Strength lenses and the universe parser. Runs
 * against the COMPILED output (see spread-math-test.mjs for why).
 *
 *   cd api && npm run build && node tools/swing-lens-test.mjs
 *
 * No network, no storage.
 */
import { readFileSync } from "node:fs";
import { parseCsv, parseFinvizExport } from "../dist/lib/swing/universe.js";
import { ema, sma, computeMaStack } from "../dist/lib/swing/maStack.js";
import { expAverage, simpleAverage, trueRange, stochasticFull, crossesFromKD, badgeFor, zigZagState, computeReversal, bullishSeries, stateFor, turnAgo, TRIGGER_BARS, JONESY } from "../dist/lib/swing/reversal.js";

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass += 1; else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

// ─── CSV / FinViz parsing ───────────────────────────────────────────────────
check("quoted commas and doubled quotes", parseCsv('a,"b, c","say ""hi"""\n1,2,3\n'), [["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
check("CRLF and blank lines", parseCsv("x,y\r\n\r\n1,2\r\n"), [["x", "y"], ["1", "2"]]);
check("BOM stripped", parseCsv("﻿Ticker\nAAPL")[0], ["Ticker"]);

const sample = [
  '"No.","Ticker","Company","Sector","Industry","Market Cap","Short Interest","Performance (Week)","Price","Change"',
  '"1","AEHR","Aehr Test Systems","Technology","Semiconductor Equipment & Materials","2813.84","12.5%","4.2%","82.10","1.10%"',
  '"2","BRK-B","Berkshire","Financial","Insurance - Diversified","1000000","-","-0.5%","500","0.0%"',
  '"3","","Ghost","Technology","Software","1","","","",""',
  '"4","aehr","Duplicate lower","Technology","x","1","","","",""',
].join("\n");
const parsed = parseFinvizExport(sample);
check("parses rows, skips blank + duplicate ticker", [parsed.rows.length, parsed.skipped], [2, 2]);
check("identity columns", [parsed.rows[0].ticker, parsed.rows[0].company, parsed.rows[0].sector, parsed.rows[0].industry, parsed.rows[0].marketCapM],
  ["AEHR", "Aehr Test Systems", "Technology", "Semiconductor Equipment & Materials", 2813.84]);
check("extras are numeric, percent signs stripped, identity excluded", parsed.rows[0].extras, { "Short Interest": 12.5, "Performance (Week)": 4.2, Price: 82.1, Change: 1.1 });
check("dash is null, not zero", "Short Interest" in parsed.rows[1].extras, false);
check("hyphenated ticker kept", parsed.rows[1].ticker, "BRK-B");
let threw = false; try { parseFinvizExport("a,b\n1,2"); } catch { threw = true; }
check("no Ticker column throws", threw, true);

// The real seed file parses to 285 names in 10 sectors.
const seed = parseFinvizExport(readFileSync(new URL("./fixtures/swing-universe-2026-09-05.csv", import.meta.url), "utf8"));
check("seed file: 285 tickers, none skipped", [seed.rows.length, seed.skipped], [285, 0]);
check("seed file: 10 sectors", new Set(seed.rows.map((r) => r.sector)).size, 10);

// ─── Averages ───────────────────────────────────────────────────────────────
const flat = Array.from({ length: 300 }, () => 100);
check("sma of a flat series", sma(flat, 50), 100);
check("ema of a flat series", ema(flat, 10), 100);
check("too short → null", [sma([1, 2, 3], 5), ema([1, 2, 3], 5)], [null, null]);
check("sma uses the LAST n", sma([1, 1, 1, 10, 10], 2), 10);
// EMA(3) seeded with SMA of first 3 = 2, then 4: 4*0.5 + 2*0.5 = 3
check("ema seed + one step", ema([1, 2, 3, 4], 3), 3);

// ─── Stack classification ───────────────────────────────────────────────────
const ramp = (from, to, n) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const bull = computeMaStack(ramp(50, 150, 300));   // steadily rising: 10 > 20 > 50 > 200
check("rising series is a bull stack", [bull.stack, bull.score, bull.c10over20, bull.c20over50, bull.c50over200], ["bull", 3, true, true, true]);
check("distances positive above every average", [bull.d10 > 0, bull.d20 > 0, bull.d50 > 0, bull.d200 > 0], [true, true, true, true]);
const bear = computeMaStack(ramp(150, 50, 300));
check("falling series is a bear stack", [bear.stack, bear.score], ["bear", 0]);
const short = computeMaStack(ramp(50, 150, 120));  // no 200 SMA yet
check("fewer than 200 bars → n/a with null 200", [short.stack, short.sma200, short.c50over200, short.score], ["n/a", null, null, 2]);
// A V-shape: long decline then sharp rally — 10 > 20 but 50 < 200 → mixed.
const v = computeMaStack([...ramp(150, 60, 250), ...ramp(60, 90, 50)]);
check("V-shape is mixed", [v.stack, v.c10over20, v.c50over200], ["mixed", true, false]);
check("bars recorded", v.bars, 300);
check("levels rounded to cents", String(bull.ema10).split(".")[1]?.length <= 2, true);

// ─── Lens 2: Jonesy port ────────────────────────────────────────────────────
const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c, volume: 1, timestamp: 0 });
check("expAverage seeds with the first value", expAverage([10, 20], 5).map((v) => Number(v.toFixed(4))), [10, 13.3333]);
check("simpleAverage nulls until full", simpleAverage([1, 2, 3, 4], 3), [null, null, 2, 3]);
check("trueRange uses previous close", trueRange([bar(1, 12, 10, 11), bar(1, 12, 10, 11), bar(1, 20, 19, 19)]), [2, 2, 9]);

// StochasticFull on a hand-checkable series: 8 bars, K period 8 → FastK on bar 7 = (close − lowest low)/(highest high − lowest low).
const sBars = [bar(10, 12, 8, 10), bar(10, 11, 9, 9), bar(9, 10, 7, 8), bar(8, 9, 7, 8.5), bar(8.5, 10, 8, 9.5), bar(9.5, 11, 9, 10.5), bar(10.5, 12, 10, 11), bar(11, 13, 10.5, 12)];
// lowest low = 7, highest high = 13, close 12 → FastK = 5/6 = 83.33 (FullK needs 3 FastK values, so still null here)
const sf = stochasticFull(sBars);
check("FullK null until slowing bars exist", sf.fullK[7], null);
const sBars2 = [...sBars, bar(12, 13, 11, 12), bar(12, 13, 11, 12)];
// bars 8 and 9 repeat close 12 with hh 13 / ll 7 (window still holds bar 2's low): FastK 83.33 three times → FullK 83.33
check("FullK = SMA3 of FastK", Number(stochasticFull(sBars2).fullK[9].toFixed(2)), 83.33);

// The cross rules, on explicit K/D series (index 3 is the bar under test).
check("Going_Up: K crosses above D with K recently < 40", crossesFromKD([30, 35, 20, 45], [40, 40, 40, 40]).goingUp, [false, false, false, true]);
check("Going_Up needs the oversold dip", crossesFromKD([50, 55, 45, 65], [60, 60, 60, 60]).goingUp[3], false);
check("Going_Up needs a strict cross (tie before is not a cross)", crossesFromKD([30, 35, 40, 45], [40, 40, 40, 40]).goingUp[3], false);
check("Going_Down: D crosses above K with D recently > 75", crossesFromKD([80, 85, 90, 70], [78, 80, 82, 75]).goingDown, [false, false, false, true]);
check("Going_Down needs the overbought D", crossesFromKD([60, 65, 70, 50], [58, 60, 62, 55]).goingDown[3], false);
check("nulls are skipped, never crash", crossesFromKD([null, 35, 20, 45], [null, 40, 40, 40]).goingUp[3], true);

// The badge rule.
check("badge: fresh up cross", badgeFor(2, 30), { signal: "bull", signalBarsAgo: 2 });
check("badge: fresh down cross", badgeFor(20, 1), { signal: "bear", signalBarsAgo: 1 });
check("badge: both fresh → the more recent", badgeFor(3, 1), { signal: "bear", signalBarsAgo: 1 });
check("badge: tie → bull", badgeFor(2, 2).signal, "bull");
check("badge: window edge is exclusive", [badgeFor(6, null).signal, badgeFor(7, null).signal], ["bull", null]);
check("badge: nothing ever fired", badgeFor(null, null).signal, null);

// ZigZag: flat, then +30% straight up → leg UP; then −30% → flips DOWN.
const zzBars = [];
for (let i = 0; i < 30; i++) zzBars.push(bar(100, 101, 99, 100));
for (let i = 1; i <= 15; i++) zzBars.push(bar(100 + 2 * i, 101 + 2 * i, 99 + 2 * i, 100 + 2 * i));
const zz1 = zigZagState(zzBars);
check("first bar undefined, UP after the rally", [zz1.dir[0], zz1.dir[zzBars.length - 1]], [0, 1]);
for (let i = 1; i <= 15; i++) zzBars.push(bar(130 - 2 * i, 131 - 2 * i, 129 - 2 * i, 130 - 2 * i));
const zz2 = zigZagState(zzBars);
check("then DOWN after the reversal", zz2.dir[zzBars.length - 1], -1);
check("legStart moves to the flip bar", zz2.legStart[zzBars.length - 1] > 45, true);
check("threshold = 1% + 2×ATR/close (+abs) on a 2-pt/bar move", Number((zz2.hlPivot[zzBars.length - 1] * 100).toFixed(1)) > 1.0, true);

// The "Bullish" plot: a turn detector on provisional extremes.
// zzBars: 30 flat, 15 up (new highs every bar → Bullish 1), 15 down. On the way down the leg
// flips to DOWN once the threshold is crossed; every new-low bar is 0; a bounce bar would be 1.
const bl = bullishSeries(zzBars);
check("up leg making new highs → Bullish 1", bl[44], true);
check("down leg making new lows → Bullish 0", bl[zzBars.length - 1], false);
// Add two bounce bars (higher lows): the EMA5-low lifts off the leg low → Bullish turns 1 without a leg flip.
const bounce = [...zzBars, bar(102, 104, 101.5, 103.5), bar(103.5, 105.5, 103, 105)];
const blB = bullishSeries(bounce);
const zzB = zigZagState(bounce);
check("bounce inside a down leg → Bullish 1 while the leg is still DOWN", [blB[bounce.length - 1], zzB.dir[bounce.length - 1]], [true, -1]);
check("turnAgo counts bars since the last change", turnAgo(blB) <= 1, true);
check("turnAgo null when the series never changed", turnAgo([true, true, true]), null);
check("state: fresh turn up → bull-triggered", stateFor(true, 0), "bull-triggered");
check("state: turn up one bar ago still triggered", stateFor(true, TRIGGER_BARS - 1), "bull-triggered");
check("state: older turn up → in progress", stateFor(true, TRIGGER_BARS), "bull-inprogress");
check("state: fresh turn down → bear-triggered", stateFor(false, 1), "bear-triggered");
check("state: older turn down → bear in progress", stateFor(false, 9), "bear-inprogress");
check("state: unknown plot → null", stateFor(null, 0), null);

// computeReversal end to end on the zig-zag series
const r = computeReversal(zzBars);
check("read carries the leg and the stochastic", [r.legUp, typeof r.fullK, r.bars], [false, "number", zzBars.length]);
check("read carries the plot state", [r.bullish, r.state], [false, "bear-inprogress"]);
check("signal window constant", JONESY.signalWindowBars, 7);
check("short history → nulls", computeReversal(zzBars.slice(0, 10)).legUp, null);

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
