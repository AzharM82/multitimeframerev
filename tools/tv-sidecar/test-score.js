'use strict';

/**
 * Verification harness for the scoring rubric.
 *
 * Fixtures are real captures from TradingView Desktop over CDP - not
 * hand-written - so a passing run proves the collector's output shape and the
 * rubric agree on live data.
 *
 * Run: node tools/tv-sidecar/test-score.js
 */

const assert = require('assert');
const path = require('path');
const { score, num, side } = require('./rules.js');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failures++; console.log(`  FAIL  ${label}\n        ${e.message}`); }
}

// ---------------------------------------------------------------- parsing
console.log('\nnumber parsing');

// TradingView emits U+2212 MINUS SIGN for negatives. Parsing it as NaN (or
// worse, dropping the sign) silently inverts every bearish signal, so these
// cases are load-bearing.
check('unicode minus parses negative', () => assert.strictEqual(num('−41.56'), -41.56));
check('ascii hyphen parses negative', () => assert.strictEqual(num('-40.6%'), -40.6));
check('percent suffix stripped', () => assert.strictEqual(num('336%'), 336));
check('dollar + M suffix', () => assert.strictEqual(num('$9.31M'), 9_310_000));
check('K suffix with space', () => assert.strictEqual(num('90.13 K'), 90_130));
check('B suffix', () => assert.strictEqual(num('44.72B'), 44_720_000_000));
check('plain number', () => assert.strictEqual(num('1.3'), 1.3));
check('non-numeric is null', () => assert.strictEqual(num('-'), null));

console.log('\ndeadband');
check('9c on $178 is flat (noise)', () => assert.strictEqual(side(177.98, 177.89), 'flat'));
check('0.21% clears the band', () => assert.strictEqual(side(177.98, 177.61), 'above'));
check('clearly below', () => assert.strictEqual(side(177.98, 193.05), 'below'));

// ---------------------------------------------------------------- scoring
console.log('\nNBIS 10m fixture (captured live 2026-07-19)');

const snap = require(path.join(__dirname, 'fixtures', 'nbis-10m.json'));
const r = score(snap);

const has = (rows, re) => rows.some((x) => re.test(x.signal));

check('symbol carried through', () => assert.strictEqual(r.symbol, 'BATS:NBIS'));
check('price extracted', () => assert.strictEqual(r.price, 177.98));
check('daily bias detected as bearish', () => assert.strictEqual(r.dailyBias, 'bear'));

// The deadband case that changed the answer: VWAP is 0.05% away, so it must
// contribute nothing to either column.
check('VWAP suppressed by deadband', () => {
  assert.ok(!has(r.bullish, /VWAP/), 'VWAP should not appear in bullish');
  assert.ok(!has(r.bearish, /VWAP/), 'VWAP should not appear in bearish');
});

check('ATR upper trigger fires bullish (weight 3)', () => {
  const row = r.bullish.find((x) => /Upper Trigger/.test(x.signal));
  assert.ok(row, 'expected Upper Trigger row');
  assert.strictEqual(row.weight, 3);
});

// RAHUL's "ATR" plot is a trailing stop line, not a volatility magnitude.
// Price 177.98 < stop 180.89 => bearish. Misreading this loses a real signal.
check('RAHUL trailing stop fires bearish', () => {
  assert.ok(has(r.bearish, /RAHUL trailing stop/), 'expected RAHUL bearish row');
});

check('daily EMA stack inverted fires bearish (weight 3)', () => {
  const row = r.bearish.find((x) => /Daily EMA stack/.test(x.signal));
  assert.ok(row, 'expected daily stack row');
  assert.strictEqual(row.weight, 3);
});

check('ribbon inverted fires bearish', () => assert.ok(has(r.bearish, /Ribbon inverted/)));
check('phase oscillator negative fires bearish', () => assert.ok(has(r.bearish, /Phase Oscillator negative/)));
check('below 5-day SMA fires bearish', () => assert.ok(has(r.bearish, /5-day SMA/)));
check('volume stack 90.1% fires bullish', () => assert.ok(has(r.bullish, /Buy-side volume/)));
check('rel vol 336% fires', () => assert.ok(has(r.bullish, /Relative volume/) || has(r.bearish, /Relative volume/)));

check('gates pass ($9.31M vol, 1.10% ADR)', () => assert.deepStrictEqual(r.gateFailures, []));

// The headline numbers from the hand-scored analysis.
check('bearish total = 14', () => assert.strictEqual(r.bearScore, 14));
check('bullish total = 12', () => assert.strictEqual(r.bullScore, 12));
check('net = -2', () => assert.strictEqual(r.net, -2));
check('verdict is BEARISH', () => assert.strictEqual(r.verdict, 'BEARISH'));

// ------------------------------------------------- NSE:NIFTY (index) fixture
// An index exercises paths a US stock never does: comma thousands separators,
// NaN float/market-cap, "N/A" sector, and a timeframe-relative ADR% that once
// filtered this symbol out entirely.
console.log('\nNSE:NIFTY 10m fixture (index edge cases)');

const nifty = score(require(path.join(__dirname, 'fixtures', 'nifty-10m.json')));

check('comma thousands separator parsed', () => assert.strictEqual(nifty.price, 24168.35));
check('NaN market cap -> null, no crash', () => assert.strictEqual(nifty.facts.avgDollarVol, 254_580_000_000));

// The bug: Swing Data's ADR%/ATR% are CHART-timeframe values. Gating on
// ADR% 0.16 (per 10m bar) < 0.5 filtered out a national index. Daily ATR is
// back-solved from the Saty trigger offset instead.
check('daily ATR back-solved from Saty levels', () => {
  assert.ok(Math.abs(nifty.facts.dailyAtr - 249.83) < 0.5, `got ${nifty.facts.dailyAtr}`);
});
check('daily ATR% ~1.03% (not the 0.16% 10m figure)', () => {
  assert.ok(Math.abs(nifty.facts.dailyAtrPct - 1.03) < 0.05, `got ${nifty.facts.dailyAtrPct}`);
});
check('index is NOT filtered out', () => assert.deepStrictEqual(nifty.gateFailures, []));

// Swing Data benchmarks non-US symbols against SPY - meaningless for NIFTY.
check('SPY sector signal suppressed for non-US', () => {
  assert.strictEqual(nifty.facts.sectorValid, false);
  assert.ok(!nifty.bullish.some((x) => /Sector/.test(x.signal)), 'sector must not score');
});

// Daily stack is up but the ATR day triggered short - this is the override.
check('daily bias bullish', () => assert.strictEqual(nifty.dailyBias, 'bull'));
check('intraday triggered short', () => assert.ok(nifty.bearish.some((x) => /Lower Trigger/.test(x.signal))));
check('verdict is COUNTER-TREND SHORT', () => assert.strictEqual(nifty.verdict, 'COUNTER-TREND SHORT'));

// ---------------------------------------------------------------- report
console.log(`\n--- ${r.symbol} @ ${r.price} (${r.resolution}m) ---`);
console.log(`VERDICT: ${r.verdict}   bull ${r.bullScore} / bear ${r.bearScore} (net ${r.net})`);
console.log('\nBULLISH');
for (const x of r.bullish) console.log(`  [${x.weight}] ${x.signal.padEnd(34)} ${x.detail}`);
console.log('\nBEARISH');
for (const x of r.bearish) console.log(`  [${x.weight}] ${x.signal.padEnd(34)} ${x.detail}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
