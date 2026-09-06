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

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
