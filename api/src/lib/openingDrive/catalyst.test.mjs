/**
 * Opening Drive — unit tests for catalyst classification.
 *
 * Covers the 2026-08-08 fix: the Finviz headline is a real classification
 * source ranked by recency against Polygon's, not display-only decoration.
 *
 * Runs against the COMPILED output so the assertions exercise exactly what
 * ships. Build first (`npm run build` in api/), then:
 *   node src/lib/openingDrive/catalyst.test.mjs   (from api/, resolves to dist/)
 *
 * `classifyCatalyst` calls Polygon for per-ticker news. The tests below use a
 * ticker that has none, so Polygon contributes nothing and the Finviz path is
 * isolated — the call still happens, it just comes back empty.
 */

import assert from "node:assert";
import {
  classifyCatalyst,
  parseFinvizNewsTime,
  priorCloseBoundary,
} from "../../../dist/lib/openingDrive/catalyst.js";
import { loadConfig } from "../../../dist/lib/openingDrive/config.js";

const cfg = loadConfig();
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failures++; console.log(`  FAIL  ${label}\n        ${e.message}`); }
}

// A ticker with no Polygon news, so only the Finviz story is in play.
const NO_NEWS_TICKER = "ZZZZNONEXISTENT";
// Friday 2026-08-07 09:28 ET (EDT, UTC-4) — a scan time. Prior close boundary
// is therefore Thursday 2026-08-06 16:00 ET.
const SCAN = new Date(Date.UTC(2026, 7, 7, 13, 28, 0));

console.log("\nparseFinvizNewsTime");

await check("parses an EDT wall clock to the right instant", () => {
  const ts = parseFinvizNewsTime("2026-08-07 15:22:33");
  assert.strictEqual(ts, Date.UTC(2026, 7, 7, 19, 22, 33)); // 15:22 EDT = 19:22 UTC
});

await check("parses an EST (winter) wall clock with the -5 offset", () => {
  const ts = parseFinvizNewsTime("2026-01-15 09:30:00");
  assert.strictEqual(ts, Date.UTC(2026, 0, 15, 14, 30, 0)); // 09:30 EST = 14:30 UTC
});

await check("handles a missing seconds field", () => {
  assert.strictEqual(parseFinvizNewsTime("2026-08-07 15:22"), Date.UTC(2026, 7, 7, 19, 22, 0));
});

await check("returns null on junk rather than guessing", () => {
  for (const bad of ["", undefined, "yesterday", "08/07/2026", "2026-08-07"]) {
    assert.strictEqual(parseFinvizNewsTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

console.log("\npriorCloseBoundary");

await check("Friday scan -> Thursday 16:00 ET", () => {
  assert.strictEqual(priorCloseBoundary(SCAN), Date.UTC(2026, 7, 6, 20, 0, 0)); // 16:00 EDT
});

await check("Monday scan rolls back over the weekend to Friday", () => {
  const mon = new Date(Date.UTC(2026, 7, 10, 13, 28, 0));
  assert.strictEqual(priorCloseBoundary(mon), Date.UTC(2026, 7, 7, 20, 0, 0));
});

console.log("\nclassifyCatalyst — the Finviz headline as a real source");

await check("a fresh Finviz story classifies NEWS (was NONE before the fix)", async () => {
  const r = await classifyCatalyst(
    NO_NEWS_TICKER, SCAN, false, false, cfg,
    "Atlassian Stock Soars 30% on Blowout Earnings and Bullish Outlook",
    "2026-08-07 07:15:00", // pre-market Friday, after Thursday's close
  );
  assert.strictEqual(r.type, "NEWS");
  assert.strictEqual(r.strength, "HIGH"); // "earnings" is a HIGH keyword
  assert.strictEqual(r.source, "finviz");
  assert.match(r.headline, /Blowout Earnings/);
});

await check("a STALE Finviz story does not classify NEWS", async () => {
  // The real shape of this: NUGT's export row carried a 2025 headline.
  const r = await classifyCatalyst(
    NO_NEWS_TICKER, SCAN, false, false, cfg,
    "Gold slides on U.S.-China trade talk hopes",
    "2025-05-07 17:47:55",
  );
  assert.strictEqual(r.type, "NONE");
  // Still attached for display, just not treated as a catalyst.
  assert.match(r.headline, /Gold slides/);
});

await check("a headline with no parseable timestamp is not treated as fresh", async () => {
  const r = await classifyCatalyst(
    NO_NEWS_TICKER, SCAN, false, false, cfg,
    "Some Company Announces Earnings", undefined,
  );
  assert.strictEqual(r.type, "NONE");
});

await check("a story published after the scan time is not fresh", async () => {
  const r = await classifyCatalyst(
    NO_NEWS_TICKER, SCAN, false, false, cfg,
    "Company beats on earnings", "2026-08-07 15:22:33", // 15:22 ET is after a 09:28 scan
  );
  assert.strictEqual(r.type, "NONE");
});

await check("a fresh Finviz story beats a price catalyst (ATH)", async () => {
  const r = await classifyCatalyst(
    NO_NEWS_TICKER, SCAN, true, false, cfg,
    "FDA approval granted", "2026-08-07 06:00:00",
  );
  assert.strictEqual(r.type, "NEWS"); // not ATH
  assert.strictEqual(r.strength, "HIGH"); // "fda" / "approval"
});

await check("price catalysts still work when there is no fresh story", async () => {
  const ath = await classifyCatalyst(NO_NEWS_TICKER, SCAN, true, false, cfg, undefined, undefined);
  assert.strictEqual(ath.type, "ATH");
  const base = await classifyCatalyst(NO_NEWS_TICKER, SCAN, false, true, cfg, undefined, undefined);
  assert.strictEqual(base.type, "BASE");
});

await check("publishedEt is reported for a Finviz-sourced story", async () => {
  const r = await classifyCatalyst(
    NO_NEWS_TICKER, SCAN, false, false, cfg,
    "Company raises guidance", "2026-08-07 07:15:00",
  );
  assert.strictEqual(r.type, "NEWS");
  assert.match(r.publishedEt, /07:15/);
});

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
