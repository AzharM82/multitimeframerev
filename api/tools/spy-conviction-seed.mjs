/**
 * Post one realistic session of conviction alerts through the live endpoint, so
 * the tab can be seen with data before TradingView is repointed at it.
 *
 * Goes through the real webhook, not straight into the table — the point is to
 * exercise the same path a TradingView alert takes, including auth, dedupe and
 * the state machine. Every row is tagged with the run id so `--clean` can
 * remove exactly what it wrote, because this talks to the SHARED PRODUCTION
 * storage account.
 *
 *   node api/tools/spy-conviction-seed.mjs            post the session
 *   node api/tools/spy-conviction-seed.mjs --clean    remove it again
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TableClient, odata } from "@azure/data-tables";

const here = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(here, "..", "local.settings.json"), "utf8")).Values;
/** The process environment wins over local.settings.json — see the E2E script. */
const pick = (n) => process.env[n] || settings[n];
const SECRET = pick("TV_WEBHOOK_SECRET");
const CONN = pick("AZURE_STORAGE_CONNECTION_STRING");
const BASE = process.env.BASE_URL || "http://localhost:4280";

const STRATEGY = "SEED_SPY_CONVICTION";
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

if (process.argv.includes("--clean")) {
  const client = TableClient.fromConnectionString(CONN, "SpyConviction");
  let removed = 0;
  for (const partition of [`evt-${today}`, `hit-${today}`]) {
    const iter = client.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition}` } });
    for await (const e of iter) {
      if (!String(e.rowKey).includes(STRATEGY) && !String(e.raw ?? "").includes(STRATEGY)) continue;
      await client.deleteEntity(e.partitionKey, e.rowKey);
      removed++;
    }
  }
  await client.deleteEntity("cstate", "current").catch(() => {});
  console.log(`removed ${removed} seeded rows + the state row`);
  process.exit(0);
}

/**
 * A plausible session: chop into the open, conviction building bearish through
 * mid-morning into an armed PUT and an entry, a reduce as it extends, an exit
 * when the score drains back toward zero, then a quiet afternoon.
 *
 * [bar, signal, action, side, score, legsAgree, grade, trigger, spy]
 */
const SESSION = [
  ["09:40", "STAND_ASIDE", "FLAT", "NONE", -8, 2, "NONE", "none", 771.90],
  ["09:50", "STAND_ASIDE", "FLAT", "NONE", -21, 3, "WEAK", "none", 771.62],
  ["10:00", "STAND_ASIDE", "FLAT", "NONE", -34, 4, "WEAK", "none", 771.35],
  ["10:10", "ARM_PUT", "ARM", "PUT", -52, 5, "MODERATE", "none", 771.04],
  ["10:20", "BUY_PUT", "BUY", "PUT", -67, 6, "STRONG", "vwap_reclaim", 770.45],
  ["10:30", "HOLD_PUT", "HOLD", "PUT", -71, 6, "STRONG", "none", 769.88],
  ["10:40", "HOLD_PUT", "HOLD", "PUT", -74, 6, "STRONG", "none", 769.20],
  ["10:50", "REDUCE_PUT", "REDUCE", "PUT", -63, 5, "STRONG", "none", 768.61],
  ["11:00", "HOLD_PUT", "HOLD", "PUT", -48, 4, "MODERATE", "none", 768.95],
  ["11:10", "HOLD_PUT", "HOLD", "PUT", -30, 3, "WEAK", "none", 769.44],
  ["11:20", "SELL_PUT", "SELL", "PUT", -12, 2, "WEAK", "none", 770.02],
  ["11:30", "STAND_ASIDE", "FLAT", "NONE", 4, 2, "NONE", "none", 770.31],
  ["12:00", "STAND_ASIDE", "FLAT", "NONE", 11, 3, "NONE", "none", 770.58],
  ["12:30", "STAND_ASIDE", "FLAT", "NONE", 19, 3, "WEAK", "none", 770.77],
  ["13:00", "STAND_ASIDE", "FLAT", "NONE", 28, 4, "WEAK", "none", 771.06],
  ["13:30", "ARM_CALL", "ARM", "CALL", 46, 5, "MODERATE", "none", 771.52],
  ["13:40", "ARM_CANCEL", "CANCEL", "NONE", 22, 3, "WEAK", "none", 771.18],
  ["14:00", "STAND_ASIDE", "FLAT", "NONE", 9, 2, "NONE", "none", 770.94],
  ["15:00", "STAND_ASIDE", "FLAT", "NONE", -6, 2, "NONE", "none", 770.71],
  ["15:30", "STAND_ASIDE", "FLAT", "NONE", -14, 3, "NONE", "none", 770.40],
];

let ok = 0, dup = 0, bad = 0;

for (const [hhmm, signal, action, side, score, legs, grade, trigger, spy] of SESSION) {
  const body = {
    strategy: STRATEGY, secret: SECRET,
    signal, action, side, score, legs_agree: legs, grade,
    bias: score < 0 ? "downside" : score > 0 ? "upside" : "neutral",
    entry_trigger: trigger, entry_dist_atr: trigger === "none" ? 0 : 0.12,
    ext_atr: Number((score / -150).toFixed(2)), bars_held: 0,
    entry_score: score, entry_px: spy,
    block_reason: Math.abs(score) < 25 && signal === "STAND_ASIDE" ? "score_below_threshold" : "none",
    spy, vwap: 771.64, ema9: Number((spy + 0.5).toFixed(2)), atr: 0.83,
    vix: Number((15 + score / -40).toFixed(2)),
    tick: Math.round(score * 8), cvd: Math.round(score * 1400),
    breadth_ratio: Number((1 + score / -40).toFixed(3)),
    tf: "10", chart_symbol: "SPY", bar_time: `${today} ${hhmm}:00`,
  };
  const res = await fetch(`${BASE}/api/spy-conviction`, {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (j.status === "ok") ok++;
  else if (j.status === "duplicate") dup++;
  else { bad++; console.log(`  ${hhmm} ${signal} -> ${res.status} ${JSON.stringify(j)}`); }
  console.log(`  ${hhmm} ${signal.padEnd(11)} score ${String(score).padStart(4)}  ${j.state ?? "?"}${j.notified ? "  [alerted]" : ""}${j.anomaly ? "  [ANOMALY]" : ""}`);
}

// One deliberately broken hit, so the tab's reject row is real and not a mock.
await fetch(`${BASE}/api/spy-conviction?token=${encodeURIComponent(SECRET)}`, {
  method: "POST", headers: { "Content-Type": "text/plain" },
  body: `${STRATEGY} — malformed alert body, not JSON`,
});

console.log(`\n${ok} accepted, ${dup} duplicate, ${bad} failed, + 1 deliberate dead letter`);
console.log(`clean up with: node api/tools/spy-conviction-seed.mjs --clean`);
