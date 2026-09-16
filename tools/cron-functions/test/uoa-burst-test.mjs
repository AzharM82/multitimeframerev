/**
 * Live burst detection — assertions, no network.
 *
 *   node test/uoa-burst-test.mjs
 *
 * This runs every two minutes against a live market and pushes results at the
 * operator while a trade is still actionable, so a wrong threshold is worse
 * than a missing one: it teaches him to ignore the tab.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../src/uoa/burst.js");

let checks = 0;
const fails = [];
const ok = (c, w) => { checks += 1; if (!c) fails.push(w); };
const eq = (a, e, w) => ok(Object.is(a, e), `${w} — expected ${e}, got ${a}`);

const cfg = B.DEFAULT_BURST;
const meta = {
  occSymbol: "NVDA261016C00200000", underlying: "NVDA", type: "C",
  strike: 200, expiry: "2026-10-16", dte: 32, priorOi: 1_000, iv: 0.5, delta: 0.4,
};

// ── the increment, not the total ───────────────────────────────────────────
// A contract that has traded 5,000 all day but only 10 since the last poll is
// not news. The EOD rule would fire on it every single poll.
eq(B.burstFor({ volume: 5_010, last: 5, bid: 4.9, ask: 5.1 }, { volume: 5_000 }, meta, cfg),
  null, "a big day with a quiet window is not a burst");

let b = B.burstFor({ volume: 5_000, last: 5, bid: 4.9, ask: 5.1 }, { volume: 4_000 }, meta, cfg);
ok(b !== null, "1,000 lots in one window on 1,000 open interest fires");
eq(b.lots, 1_000, "lots counts only this window");
eq(b.day_volume, 5_000, "the cumulative total is carried for context");
eq(b.oi_share, 1, "the window alone traded the whole outstanding interest");
eq(b.day_vol_oi, 5, "the session ratio is reported separately");
eq(b.notional, 500_000, "notional is this window's lots, not the day's");

// First sight of a contract measures from zero — everything it has done is new
// to us, which is the honest reading when the watch set gains a contract.
b = B.burstFor({ volume: 900, last: 6, bid: 5.9, ask: 6.1 }, undefined, meta, cfg);
eq(b.lots, 900, "a contract seen for the first time counts from zero");

// Cumulative volume must never go backwards; if it does, do not invent a
// negative burst.
b = B.burstFor({ volume: 800, last: 6, bid: 5.9, ask: 6.1 }, { volume: 5_000 }, meta, cfg);
eq(b.lots, 800, "a volume reset restarts from the new figure");

// ── the gates ──────────────────────────────────────────────────────────────
eq(B.burstFor({ volume: 1_100, last: 5, bid: 4.9, ask: 5.1 }, { volume: 1_000 }, meta, cfg),
  null, "100 lots is under the minimum however unusual");
eq(B.burstFor({ volume: 1_400, last: 0.05, bid: 0.04, ask: 0.06 }, { volume: 1_000 }, meta, cfg),
  null, "a nickel contract cannot clear the notional floor");
eq(B.burstFor({ volume: 1_400, last: 0.09, bid: 0.08, ask: 0.1 }, { volume: 1_000 }, meta, cfg),
  null, "contracts under a dime are skipped — the spread swamps the signal");
eq(B.burstFor({ volume: 1_400, last: 5, bid: 4.9, ask: 5.1 }, { volume: 1_000 }, { ...meta, priorOi: 10 }, cfg),
  null, "open interest below the floor is unmeasurable, not infinitely unusual");
eq(B.burstFor({ volume: 1_400, last: 5, bid: 4.9, ask: 5.1 }, { volume: 1_000 }, { ...meta, priorOi: null }, cfg),
  null, "missing open interest never fires");
eq(B.burstFor({ volume: 1_300, last: 0.5, bid: 0.45, ask: 0.55 }, { volume: 1_000 }, { ...meta, priorOi: 5_000 }, cfg),
  null, "300 lots against 5,000 open interest is 6% — ordinary");
ok(B.burstFor({ volume: 1_800, last: 0.7, bid: 0.65, ask: 0.75 }, { volume: 1_000 }, { ...meta, priorOi: 5_000 }, cfg) !== null,
  "800 lots against 5,000 open interest is 16% — that fires");

// Either test qualifies, and neither is required to carry the other. Demanding
// both would drop the largest prints in the most liquid names, which are the
// ones worth seeing.
ok(B.burstFor({ volume: 6_000, last: 5, bid: 4.9, ask: 5.1 }, { volume: 1_000 }, { ...meta, priorOi: 500_000 }, cfg) !== null,
  "$2.5m committed fires even at 1% of a huge open interest");
ok(B.burstFor({ volume: 1_400, last: 2, bid: 1.95, ask: 2.05 }, { volume: 1_000 }, { ...meta, priorOi: 1_000 }, cfg) !== null,
  "40% of open interest fires on $80k of premium, well under the big-money bar...");
eq(B.burstFor({ volume: 1_300, last: 2, bid: 1.95, ask: 2.05 }, { volume: 1_000 }, { ...meta, priorOi: 5_000 }, cfg),
  null, "...but 6% of open interest on $60k is small on both counts and stays quiet");

// ── which side leaned ──────────────────────────────────────────────────────
eq(B.inferSide(5.1, 4.9, 5.1), "bought", "a print at the ask leans bought");
eq(B.inferSide(4.9, 4.9, 5.1), "sold", "a print at the bid leans sold");
eq(B.inferSide(5.0, 4.5, 5.5), "mid", "a print in the middle of a wide spread is neither");
eq(B.inferSide(5.3, 4.9, 5.1), "bought", "a print through the ask leans bought");
eq(B.inferSide(null, 4.9, 5.1), null, "no print means no lean");
eq(B.inferSide(5.0, null, 5.1), null, "no bid means no lean rather than a guess");
eq(B.inferSide(5.0, 0, 0), null, "an empty quote means no lean");
eq(B.inferSide(5.0, 5.2, 5.1), null, "a crossed market says nothing about who crossed");
// A one-cent-wide quote must still resolve rather than collapsing to "mid".
eq(B.inferSide(5.01, 5.0, 5.01), "bought", "a penny-wide quote still resolves");

// ── the sweep over a poll ──────────────────────────────────────────────────
const metaMap = {
  A: { ...meta, occSymbol: "A", underlying: "AAA" },
  B: { ...meta, occSymbol: "B", underlying: "BBB", type: "P" },
};
const quotes = [
  { symbol: "A", volume: 2_000, last: 3, bid: 2.9, ask: 3.1 },
  { symbol: "B", volume: 2_000, last: 20, bid: 19.9, ask: 20.1 },
  { symbol: "UNKNOWN", volume: 99_999, last: 50, bid: 49, ask: 51 },
];
const prev = { A: { volume: 1_000 }, B: { volume: 1_000 } };
const bursts = B.detectBursts(quotes, prev, metaMap, cfg);
eq(bursts.length, 2, "a contract not in the watch set is ignored, not crashed on");
eq(bursts[0].underlying, "BBB", "sorted by dollars committed, not by lot count");
eq(bursts[0].notional, 2_000_000, "the $20 contract is the bigger statement");
eq(bursts[1].notional, 300_000, "the $3 contract, same lots, ranks below it");
eq(B.detectBursts(quotes, {}, metaMap, cfg).length, 2, "an empty previous poll still works");
eq(B.detectBursts([], prev, metaMap, cfg).length, 0, "no quotes, no bursts");

// ── the state handed to the next poll ──────────────────────────────────────
const snap = B.snapshot(quotes);
eq(Object.keys(snap).length, 3, "every quote is remembered, watch set or not");
eq(snap.A.volume, 2_000, "cumulative volume carried forward");
eq(B.snapshot([{ symbol: "Z", last: 1 }]).Z.volume, 0, "a missing volume carries as zero, not undefined");

if (fails.length) {
  console.error(`FAIL — ${fails.length} of ${checks} checks\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`PASS — ${checks} assertions (increment vs total + gates + side lean + sweep + state)`);
