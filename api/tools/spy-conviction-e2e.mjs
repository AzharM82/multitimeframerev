/**
 * End-to-end check of the SPY Conviction sink against a running emulator.
 *
 * The parity script covers the pure logic. This covers what only a real
 * deployment can: auth, Table-backed dedupe, the audit read, and the fact that
 * both routes are the same handler. It posts exactly the way TradingView does —
 * text/plain with a JSON body and the secret inside it.
 *
 *   npx swa start dist --api-location api        # in another shell
 *   node api/tools/spy-conviction-e2e.mjs [baseUrl]
 *
 * Reads TV_WEBHOOK_SECRET and TIMER_SECRET from api/local.settings.json and
 * never prints them. Cleans up every row it wrote, so a run leaves the table as
 * it found it — this talks to the SHARED PRODUCTION storage account.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TableClient, odata } from "@azure/data-tables";

const here = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(here, "..", "local.settings.json"), "utf8")).Values;

/**
 * The PROCESS environment wins over local.settings.json — Core Tools does not
 * overwrite a variable that is already set, and this machine carries a
 * user-level TIMER_SECRET. Reading the file alone gets you the
 * `local-dev-only-placeholder`, a 401 from every timer endpoint, and half an
 * hour spent debugging code that was never wrong.
 */
const pick = (name) => process.env[name] || settings[name];
const SECRET = pick("TV_WEBHOOK_SECRET");
const TIMER = pick("TIMER_SECRET");
const CONN = pick("AZURE_STORAGE_CONNECTION_STRING");
const BASE = process.argv[2] || "http://localhost:4280";

if (!SECRET) throw new Error("TV_WEBHOOK_SECRET missing from local.settings.json");

/** A bar_time far outside market hours so a test row can never be mistaken for
 *  a real alert on the tab, and cleanup can find it by prefix. */
const RUN = `E2E_${Date.now()}`;
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
function eq(a, b, what = "value") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const BASE_ALERT = {
  strategy: RUN, secret: SECRET,
  signal: "BUY_PUT", action: "BUY", side: "PUT",
  grade: "STRONG", bias: "downside", score: -67, legs_agree: 6,
  entry_trigger: "vwap_reclaim", entry_dist_atr: 0.12, ext_atr: -0.44,
  bars_held: 0, entry_score: -67, entry_px: 770.45, block_reason: "none",
  spy: 770.45, vwap: 771.64, ema9: 770.98, atr: 0.83, vix: 15.33,
  tick: -36, cvd: -90000, breadth_ratio: 3.491,
  tf: "10", chart_symbol: "SPY", bar_time: `${today} 09:50:00`,
};

/** Post exactly as TradingView does: text/plain, JSON body, secret inside. */
async function post(overrides = {}, { path = "/api/spy-conviction", raw = null } = {}) {
  const body = raw ?? JSON.stringify({ ...BASE_ALERT, ...overrides });
  const res = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "Content-Type": "text/plain" }, body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null, the test will say so */ }
  return { status: res.status, json, text };
}

console.log(`\nSPY Conviction E2E → ${BASE}  (strategy ${RUN})\n`);
console.log("auth");

await check("no secret at all → 401", async () => {
  const r = await post({}, { raw: JSON.stringify({ ...BASE_ALERT, secret: undefined }) });
  eq(r.status, 401, "status");
});

await check("wrong secret → 401", async () => {
  eq((await post({ secret: "definitely-not-the-secret-value" })).status, 401, "status");
});

await check("secret in the query string is accepted too", async () => {
  const res = await fetch(`${BASE}/api/spy-conviction?token=${encodeURIComponent(SECRET)}`, {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ ...BASE_ALERT, secret: undefined, signal: "STAND_ASIDE", action: "FLAT", side: "NONE", bar_time: `${today} 09:31:00` }),
  });
  eq(res.status, 200, "status");
});

console.log("\nmalformed input");

await check("garbage body → 200 + deadletter (never 4xx)", async () => {
  // Authenticated via the query string: a garbage body cannot carry a secret,
  // so this is the only way to separate "TradingView sent nonsense" (200,
  // dead-lettered, feed stays alive) from "a stranger knocked" (401).
  const res = await fetch(`${BASE}/api/spy-conviction?token=${encodeURIComponent(SECRET)}`, {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: `${RUN} this is not json at all`,
  });
  eq(res.status, 200, "status — a 4xx would make TradingView disable the alert");
  eq((await res.json()).status, "deadletter", "status field");
});

await check("valid JSON, unknown signal → deadletter", async () => {
  const r = await post({ signal: "NOT_A_SIGNAL" });
  eq(r.status, 200, "status");
  eq(r.json?.status, "deadletter", "status field");
  ok(/NOT_A_SIGNAL/.test(r.json?.reason ?? ""), "the reason should name the signal");
});

console.log("\nlifecycle + dedupe (Table-backed)");

const seq = [
  ["ARM_PUT",    "ARM",    "09:50", "ARMED_PUT", true],
  ["BUY_PUT",    "BUY",    "10:00", "LONG_PUT",  true],
  ["HOLD_PUT",   "HOLD",   "10:10", "LONG_PUT",  false],
  ["REDUCE_PUT", "REDUCE", "10:20", "LONG_PUT",  true],
  ["SELL_PUT",   "SELL",   "10:30", "FLAT",      true],
];

for (const [signal, action, hhmm, expectState, expectNotify] of seq) {
  await check(`${signal} → ${expectState}${expectNotify ? "" : " (silent)"}`, async () => {
    const r = await post({ signal, action, side: "PUT", bar_time: `${today} ${hhmm}:00` });
    eq(r.status, 200, "status");
    eq(r.json?.status, "ok", `status field (${r.text.slice(0, 200)})`);
    eq(r.json?.state, expectState, "state");
    eq(r.json?.anomaly, false, "anomaly flag");
    // notifyBoth returns {pushover,whatsapp}; locally neither is configured, so
    // assert the GATE fired, not that a phone buzzed.
    eq(r.json?.notified !== false, expectNotify, "notify gate");
  });
}

await check("replaying BUY_PUT is a duplicate, not a second entry", async () => {
  const r = await post({ signal: "BUY_PUT", action: "BUY", side: "PUT", bar_time: `${today} 10:00:00` });
  eq(r.status, 200, "status");
  eq(r.json?.status, "duplicate", "status field");
});

await check("out-of-order SELL while flat is flagged, not fatal", async () => {
  const r = await post({ signal: "SELL_CALL", action: "SELL", side: "CALL", bar_time: `${today} 10:40:00` });
  eq(r.json?.status, "ok", "status field");
  eq(r.json?.anomaly, true, "anomaly flag");
});

console.log("\nroute alias");

await check("the legacy tv-trend-webhook URL is the same handler", async () => {
  const r = await post(
    { signal: "ARM_CALL", action: "ARM", side: "CALL", bar_time: `${today} 11:00:00` },
    { path: "/api/tv-trend-webhook" },
  );
  eq(r.status, 200, "status");
  eq(r.json?.status, "ok", "status field");
  eq(r.json?.state, "ARMED_CALL", "state");
});

console.log("\naudit read");

await check("GET without a principal or timer secret → 401", async () => {
  eq((await fetch(`${BASE}/api/spy-conviction`)).status, 401, "status");
});

await check("GET with the timer secret returns today's alerts", async () => {
  const res = await fetch(`${BASE}/api/spy-conviction`, { headers: { "x-timer-secret": TIMER } });
  eq(res.status, 200, "status");
  const j = await res.json();
  eq(j.date, today, "date");
  const mine = j.events.filter((e) => e.strategy === RUN);
  ok(mine.length >= 6, `expected >=6 of this run's events, got ${mine.length}`);
  ok(j.hits.length > 0, "raw hits should be recorded");
  ok(j.hits.some((h) => String(h.decision).startsWith("rejected")),
     "rejects must be visible in the audit payload, not only in a log");
  const buy = mine.find((e) => e.signal === "BUY_PUT");
  ok(buy, "the BUY_PUT event was not persisted");
  eq(buy.line, "BUY_PUT | score -67 6/6 | vwap_reclaim @0.12 ATR | SPY 770.45 | 10:00", "stored line");
  eq(buy.legsAgree, 6, "legs persisted");
  eq(buy.vix, 15.33, "VIX leg persisted");
});

await check("force-flat resets the belief", async () => {
  const res = await fetch(`${BASE}/api/spy-conviction?flat=1`, {
    method: "POST", headers: { "x-timer-secret": TIMER },
  });
  eq(res.status, 200, "status");
  eq((await res.json()).now, "FLAT", "resulting state");
});

// ── cleanup ─────────────────────────────────────────────────────────────────
// This ran against the shared PRODUCTION storage account. Leave nothing behind.

console.log("\ncleanup");
try {
  const client = TableClient.fromConnectionString(CONN, "SpyConviction");
  let removed = 0;
  for (const partition of [`evt-${today}`, `hit-${today}`]) {
    const iter = client.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition}` } });
    for await (const e of iter) {
      const mine = String(e.rowKey).includes(RUN) || String(e.raw ?? "").includes(RUN);
      if (!mine) continue;
      await client.deleteEntity(e.partitionKey, e.rowKey);
      removed++;
    }
  }
  await client.deleteEntity("cstate", "current").catch(() => {});
  console.log(`  removed ${removed} test rows + the test state row`);
} catch (err) {
  console.log(`  WARNING cleanup failed: ${err.message} — remove ${RUN} rows by hand`);
}

const total = pass + failures.length;
console.log(`\n${pass}/${total} passed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
