/**
 * Phase 2 validation harness: run the Jonesy port over the operator's TOS sample
 * sets (api/tools/fixtures/reversal-samples-2026-09-05.json) and report how each
 * candidate definition of "bullish reversal" / "bearish reversal" matches.
 *
 *   cd api && npm run build && node tools/swing-reversal-check.mjs [asOf=2026-09-04]
 *
 * Reads POLYGON_API_KEY from api/local.settings.json (never printed). Network:
 * one daily-aggregates call per ticker. Storage: none.
 */
import { readFileSync } from "node:fs";
import { computeReversal, zigZagState, stochCrosses } from "../dist/lib/swing/reversal.js";

const settings = JSON.parse(readFileSync(new URL("../local.settings.json", import.meta.url), "utf8")).Values;
const KEY = process.env.POLYGON_API_KEY || settings.POLYGON_API_KEY;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/reversal-samples-2026-09-05.json", import.meta.url), "utf8"));
const asOf = process.argv[2] || fixture.asOf;

async function bars(ticker) {
  const from = new Date(asOf); from.setDate(from.getDate() - 730);
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from.toISOString().slice(0, 10)}/${asOf}?adjusted=true&sort=asc&limit=50000`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${ticker}: ${res.status}`);
  const d = await res.json();
  return (d.results ?? []).map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, timestamp: b.t }));
}

const tickers = [...fixture.bullish.map((t) => [t, "bull"]), ...fixture.bearish.map((t) => [t, "bear"])];
const rows = [];
for (const [t, expected] of tickers) {
  try {
    const c = await bars(t);
    const r = computeReversal(c);
    const zz = zigZagState(c); const st = stochCrosses(c);
    const last = c.length - 1;
    // extra context: leg direction 1/2/3 bars ago, crosses within the last 3/5 bars
    const legUpPrev = [1, 2, 3].map((k) => zz.dir[last - k]);
    const upWithin = (n) => st.goingUp.slice(last - n + 1).some(Boolean);
    const downWithin = (n) => st.goingDown.slice(last - n + 1).some(Boolean);
    rows.push({ t, expected, lastDate: new Date(c[last].timestamp).toISOString().slice(0, 10), ...r, legUpPrev, up3: upWithin(3), down3: downWithin(3), up5: upWithin(5), down5: downWithin(5) });
  } catch (e) { rows.push({ t, expected, error: String(e.message ?? e) }); }
}

const ok = rows.filter((r) => !r.error);
console.log(`as of ${asOf}: ${ok.length}/${rows.length} tickers priced; last bar dates: ${[...new Set(ok.map((r) => r.lastDate))].join(", ")}`);
if (rows.some((r) => r.error)) console.log("errors:", rows.filter((r) => r.error).map((r) => `${r.t} ${r.error}`).join(" | "));

console.log(`\n${"tkr".padEnd(6)} ${"exp".padEnd(4)} ${"leg".padEnd(5)} ${"legBars".padStart(7)} ${"thr%".padStart(5)} ${"K".padStart(6)} ${"D".padStart(6)} ${"upAgo".padStart(5)} ${"dnAgo".padStart(5)}  legPrev(1,2,3)`);
for (const r of ok) {
  console.log(`${r.t.padEnd(6)} ${r.expected.padEnd(4)} ${String(r.legUp === null ? "?" : r.legUp ? "UP" : "DOWN").padEnd(5)} ${String(r.legBars ?? "-").padStart(7)} ${String(r.thresholdPct ?? "-").padStart(5)} ${String(r.fullK ?? "-").padStart(6)} ${String(r.fullD ?? "-").padStart(6)} ${String(r.goingUpBarsAgo ?? "-").padStart(5)} ${String(r.goingDownBarsAgo ?? "-").padStart(5)}  ${r.legUpPrev.join(",")}`);
}

// ─── Candidate definitions ──────────────────────────────────────────────────
const candidates = {
  "A  bull = leg UP · bear = leg DOWN (Bullish plot)": (r) => (r.legUp === true ? "bull" : r.legUp === false ? "bear" : "none"),
  "B  bull = Going_Up today · bear = Going_Down today": (r) => (r.goingUp ? "bull" : r.goingDown ? "bear" : "none"),
  "C  bull = Going_Up ≤3 bars · bear = Going_Down ≤3 bars": (r) => (r.up3 ? "bull" : r.down3 ? "bear" : "none"),
  "D  bull = Going_Up ≤5 bars · bear = Going_Down ≤5 bars": (r) => (r.up5 ? "bull" : r.down5 ? "bear" : "none"),
  "E  bull = leg UP & K>D · bear = leg DOWN & K<D": (r) => (r.legUp === true && r.fullK > r.fullD ? "bull" : r.legUp === false && r.fullK < r.fullD ? "bear" : "none"),
  "F  bull = K>D · bear = K<D (stochastic side only)": (r) => (r.fullK === null ? "none" : r.fullK > r.fullD ? "bull" : "bear"),
  "G  THE TAB BADGE: more recent cross within the 7-bar window": (r) => r.signal ?? "none",
  "H  bull = Going_Up ≤7 bars · bear = Going_Down ≤9 bars (either, up wins)": (r) => (r.goingUpBarsAgo !== null && r.goingUpBarsAgo < 7 ? "bull" : r.goingDownBarsAgo !== null && r.goingDownBarsAgo < 9 ? "bear" : "none"),
};
console.log("\nMatch against the operator's sets (bull set = 50, bear set = 20):");
for (const [name, fn] of Object.entries(candidates)) {
  const got = ok.map((r) => ({ ...r, got: fn(r) }));
  const bullHit = got.filter((r) => r.expected === "bull" && r.got === "bull").length;
  const bearHit = got.filter((r) => r.expected === "bear" && r.got === "bear").length;
  const bullTotal = got.filter((r) => r.expected === "bull").length, bearTotal = got.filter((r) => r.expected === "bear").length;
  const misses = got.filter((r) => r.expected !== r.got).map((r) => `${r.t}(${r.got})`);
  console.log(`  ${name}\n     bull ${bullHit}/${bullTotal} · bear ${bearHit}/${bearTotal} · total ${bullHit + bearHit}/${ok.length}${misses.length ? `\n     misses: ${misses.join(" ")}` : ""}`);
}
