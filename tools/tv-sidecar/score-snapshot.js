'use strict';

/**
 * Score any captured snapshot and print the two-table report.
 * Run: node tools/tv-sidecar/score-snapshot.js fixtures/nifty-10m.json
 */

const path = require('path');
const fs = require('fs');
const { score } = require('./rules.js');

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node score-snapshot.js <snapshot.json>');
  process.exit(2);
}

const file = path.isAbsolute(arg) ? arg : path.join(__dirname, arg);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const r = score(snap);

const pad = (s, n) => String(s).padEnd(n);

console.log(`\n=== ${r.symbol} @ ${r.price}  (${r.resolution}m) ===`);
console.log(`VERDICT: ${r.verdict}`);
console.log(`daily bias: ${r.dailyBias ?? 'none'}   bull ${r.bullScore} / bear ${r.bearScore}   net ${r.net > 0 ? '+' : ''}${r.net}`);
if (r.gateFailures.length) console.log(`GATE FAILURES: ${r.gateFailures.join('; ')}`);

console.log('\nBULLISH');
if (!r.bullish.length) console.log('  (none)');
for (const x of r.bullish) console.log(`  [${x.weight}] ${pad(x.signal, 34)} ${x.detail}`);

console.log('\nBEARISH');
if (!r.bearish.length) console.log('  (none)');
for (const x of r.bearish) console.log(`  [${x.weight}] ${pad(x.signal, 34)} ${x.detail}`);

// Surface facts the rubric could not read - an index legitimately has no
// float/market cap, but a silently-empty fact is indistinguishable from a
// misconfigured chart unless it is reported.
const missing = Object.entries(r.facts)
  .filter(([k, v]) => v === null && !['sectorLabel'].includes(k))
  .map(([k]) => k);
if (missing.length) console.log(`\nUNREAD FACTS (${missing.length}): ${missing.join(', ')}`);
console.log('');
