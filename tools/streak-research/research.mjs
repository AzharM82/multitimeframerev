#!/usr/bin/env node
/**
 * SPY conviction research agent — end of day.
 *
 *   1. read the day's conviction alerts from the portal
 *   2. replay them against REAL SPY option bars under many timing/instrument variants
 *   3. hand the resulting table to the Claude CLI for interpretation
 *   4. push the report back, where it renders under the SPY Conviction tab
 *
 * Repointed from the breadth-streak system on 2026-08-12. The indicator now
 * emits the decision itself, so the variants are no longer "which regime filter"
 * but "when to act on what it said" — enter at the ARM or wait for the BUY, exit
 * at the first REDUCE or hold for the SELL, gate on score strength.
 *
 * WHY LOCAL, like tools/journal-sync: step 3 uses the Claude CLI against the
 * existing subscription, so no model key ever reaches Azure.
 *
 * WHAT IT WILL NOT DO: change anything. It reports. A research agent with write
 * access to live trading rules is how a system drifts without anyone deciding to.
 *
 * THE SAMPLE-SIZE GATE IS THE POINT, and the conviction cutover reset the clock
 * — these signals start on 2026-08-12 and cannot be backfilled, because the
 * legs live on TradingView's side. With a handful of trades a variant sweep is
 * noise wearing a table's clothes. Below MIN_TRADES the agent is told to say so
 * and stop; the failure mode being guarded against already happened on this
 * stack, when the DTSWAI nightly agent spent weeks writing confident reports off
 * an empty dataset and nobody could tell from the reports.
 *
 *   node research.mjs                 last completed session
 *   node research.mjs --date 2026-08-12
 *   node research.mjs --dry-run       compute + print, push nothing
 *   node research.mjs --portal http://localhost:4280
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { spyBars, pairConvictionTrades, priceTrade, summarise, fetchStats, etHHMM } from "./simulate.mjs";
import { tvAvailable, tvCurrentView, tvRestoreView } from "./tvbars.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(" ", ...a);

/** Below this many independent entries the agent reports insufficient data. */
const MIN_TRADES = 20;

/**
 * The live timing, and the alternatives worth arguing with.
 *
 * Each one answers a question the indicator deliberately leaves open, so a
 * winner here is a change to WHEN the operator acts, not to what the indicator
 * computes.
 */
const RULE_SETS = [
  { id: "live", label: "LIVE: enter on BUY, exit on SELL",
    entry: "buy", exit: "sell" },
  { id: "arm-entry", label: "enter on the ARM instead of waiting for the trigger",
    entry: "arm", exit: "sell" },
  { id: "exit-on-reduce", label: "exit at the first REDUCE instead of holding for the SELL",
    entry: "buy", exit: "reduce" },
  { id: "score-fade-30", label: "exit when |score| fades below 30, whatever the signal says",
    entry: "buy", exit: "sell", exitBelowScore: 30 },
  { id: "hold-to-close", label: "enter on BUY and never exit early (forced flat at the bell)",
    entry: "buy", exit: "hold" },
  { id: "strong-only", label: "only entries with |score| >= 70, exit on SELL",
    entry: "buy", exit: "sell", minScore: 70 },
];

/** Instrument variants. otmSteps 0 = first strike beyond spot. */
const INSTRUMENTS = [
  { id: "0dte-otm1", expiryDays: 0, otmSteps: 0 },
  { id: "1d-otm1", expiryDays: 1, otmSteps: 0 },
  { id: "2d-atm", expiryDays: 2, otmSteps: -1 },
  { id: "2d-otm1", expiryDays: 2, otmSteps: 0 },
  { id: "2d-otm2", expiryDays: 2, otmSteps: 1 },
  { id: "2d-otm3", expiryDays: 2, otmSteps: 2 },
  { id: "4d-otm1", expiryDays: 4, otmSteps: 0 },
];

function loadEnv() {
  const file = path.join(HERE, "research.env");
  if (!fs.existsSync(file)) {
    console.error(`\n  ERROR  missing ${file} — copy .env.example and fill it in\n`);
    process.exit(1);
  }
  const cfg = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const k of ["PORTAL_URL", "PORTAL_TIMER_SECRET", "POLYGON_API_KEY"]) {
    if (!cfg[k]) { console.error(`\n  ERROR  research.env is missing ${k}\n`); process.exit(1); }
  }
  return cfg;
}

async function fetchDay(cfg, date) {
  const res = await fetch(`${cfg.PORTAL_URL}/api/spy-conviction?date=${date}`, {
    headers: { "x-timer-secret": cfg.PORTAL_TIMER_SECRET },
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.error(`\n  ERROR  portal returned HTTP ${res.status} reading ${date}\n`);
    process.exit(1);
  }
  return res.json();
}

/** Headless Claude, prompt on STDIN — same reasoning as journal-sync. */
function runClaude(prompt) {
  const bin = process.platform === "win32" ? "claude.exe" : "claude";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("claude timed out after 5 min")); }, 300_000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not run ${bin}: ${e.message}`)); });
    child.on("close", (c) => { clearTimeout(timer); c === 0 ? resolve(out) : reject(new Error(`claude exited ${c}: ${err.slice(0, 300)}`)); });
    child.stdin.end(prompt, "utf8");
  });
}

function buildPrompt(dates, table, totals, mechanicsOnly) {
  const date = dates.length > 1 ? `${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} sessions)` : dates[0];
  return `You are reviewing a SPY conviction-score alert system.

The system: a TradingView indicator scores six legs on every closed 10-minute
SPY bar — cumulative TICK, volume pressure, SPY vs VWAP, SPY vs EMA9, SPY/RSP
relative strength, and VIX — into one score from -100 to +100, and reports how
many of the six agree. It emits the decision itself: ARM when conviction builds,
BUY when an entry trigger confirms, HOLD, REDUCE as it extends, SELL when it
drains. It alerts a human; it places no orders and sizes nothing.

The variants below do NOT change the score. They change WHEN the operator acts
on it — enter at the ARM or wait for the BUY, exit at the first REDUCE or hold
for the SELL, gate on how strong the score was at entry. Each was replayed
against REAL SPY option 5-minute bars. Fills are the next bar's OPEN after the
signal. P&L is dollars per single contract.

DATE: ${date}
INDEPENDENT ENTRY SIGNALS THIS DAY: ${totals.independentSignals} (BUY_CALL/BUY_PUT in the raw stream)
ARM SIGNALS (a superset — some never trigger): ${totals.armSignals}
FIRST/LAST ALERT (ET): ${totals.firstSignal} / ${totals.lastSignal}
SIGNALS OUTSIDE REGULAR HOURS: ${totals.outsideRth}
OUT-OF-ORDER TRANSITIONS: ${totals.anomalies}
UNPRICEABLE LEGS: ${totals.skipSummary}
(Every row re-prices those same signals under a different rule set and
instrument. ${totals.rowsAcrossSweep} priced rows across the sweep is NOT
${totals.rowsAcrossSweep} independent observations.)

${table}

${mechanicsOnly ? `THIS IS A MECHANICS REVIEW ONLY. ${totals.independentSignals} independent entries is
far too few to say anything about profitability. You must NOT rank the variants,
recommend one, or draw any performance conclusion — not even a hedged one.
Report only on correctness: variants that produced identical results (and what
that implies), unpriceable contracts, trades force-closed at the session end,
signals outside regular hours, out-of-order transitions, and anything in the
table that looks like a bug rather than a result. End with what to fix in the
code.` : `Write a short report for the trader. Rules:
- Lead with what the data can and cannot support. Never imply significance you
  cannot have, and rank variants only if the independent sample really supports it.`}
- Prefer observations that would hold up: a variant that never opened a trade, an
  instrument that could not be priced, a rule that structurally cannot fire.
- If something looks promising, say what evidence would confirm it and roughly how
  many days of data that needs.
- Call out mechanical problems over performance ones: unpriceable contracts, trades
  left open at the close, signals arriving outside regular hours.
- Be concrete about code: name the rule or parameter you would change and why.
- No trading advice beyond what the numbers show. No invented figures.

Output plain markdown, at most 400 words. No preamble.`;
}

// ── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const dateArg = argv.includes("--date") ? argv[argv.indexOf("--date") + 1] : null;
const portalOverride = argv.includes("--portal") ? argv[argv.indexOf("--portal") + 1] : null;
const daysArg = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : 1;

const cfg = loadEnv();
if (portalOverride) cfg.PORTAL_URL = portalOverride.replace(/\/$/, "");
/**
 * Default to the LAST COMPLETED session, not today.
 *
 * Polygon sells this plan option history from T-1 back and refuses the current
 * session outright (403 "plan doesn't include this data timeframe", verified
 * 2026-08-11 for every expiry, while SPY equity bars for the same day are fine).
 * So an "end of day" report necessarily covers yesterday; defaulting to today
 * would 403 on the first contract every single run.
 */
function previousSession(from = new Date()) {
  const d = new Date(from.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T12:00:00Z");
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
/**
 * Today when TradingView can price it, otherwise the previous session.
 *
 * TradingView serves the CURRENT session's option bars; Polygon refuses them.
 * So the report is same-day whenever the desktop app is up, and silently falls
 * back to yesterday when it is not — rather than producing a run where every
 * contract 403s.
 */
// Honour the configured source. With Polygon (the default) TradingView is never
// contacted, so the chart is never touched and the report covers the PREVIOUS
// session — Polygon will not sell the current one.
const BAR_SOURCE = (cfg.BAR_SOURCE || process.env.BAR_SOURCE || "polygon").toLowerCase();
process.env.BAR_SOURCE = BAR_SOURCE;
const tvUp = BAR_SOURCE === "polygon" ? false : await tvAvailable();
const endDate = dateArg ?? (tvUp
  ? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })
  : previousSession());

/**
 * A sweep walks the operator's chart through dozens of contracts, so put it
 * back where they left it. Best-effort: failing to restore a chart must never
 * fail a report.
 */
let savedView = null;
const restoreChart = async () => {
  if (!savedView) return;
  try { await tvRestoreView(savedView); } catch { /* chart may have been closed */ }
};

/**
 * Weekday sessions ending at endDate. Each day is simulated SEPARATELY and the
 * trades concatenated — never merged into one stream. A position does not
 * survive the close (the live system resets at session start), and the option
 * chain is chosen relative to each day's own spot and expiry, so pairing across
 * a day boundary would invent trades that could not exist.
 */
function sessionsEnding(end, n) {
  const out = [];
  const d = new Date(`${end}T12:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}
const dates = sessionsEnding(endDate, Math.max(1, daysArg));
const date = dates[dates.length - 1];

console.log(`\nconviction-research  ${date}${dryRun ? "  [DRY RUN]" : ""}`);
console.log(`portal: ${cfg.PORTAL_URL}\n`);
console.log(`option bars: ${BAR_SOURCE} ${tvUp ? "— TradingView reachable, same-day" : "— previous session (Polygon has no current-day option data)"}
`);
if (tvUp) savedView = await tvCurrentView().catch(() => null);

const sessions = [];
for (const d of dates) {
  const day = await fetchDay(cfg, d);
  const evs = (day.events ?? []).filter((e) => e.signal);
  if (evs.length === 0) { log(`${d}: no conviction alerts — skipped`); continue; }
  const bars = await spyBars(d, cfg.POLYGON_API_KEY);
  sessions.push({ date: d, events: evs, spy: bars, anomalies: evs.filter((e) => e.anomaly).length });
  log(`${d}: ${evs.length} alerts, ${bars.size} SPY bars`);
}
if (sessions.length === 0) {
  log("nothing to analyse in this range — no report written");
  process.exit(0);
}
const events = sessions.flatMap((s) => s.events);

const rows = [];
for (const rules of RULE_SETS) {
  let signalCount = 0;
  for (const inst of INSTRUMENTS) {
    const priced = [];
    for (const s of sessions) {
      const trades = pairConvictionTrades(s.events, rules);   // per session, never across days
      if (inst === INSTRUMENTS[0]) signalCount += trades.length;
      for (const t of trades) {
        try {
        priced.push(await priceTrade(t, inst, {
          date: s.date, key: cfg.POLYGON_API_KEY, spy: s.spy,
          // Option bars are paced at ~5/min, so a cold sweep takes minutes. Say
          // so as it happens rather than looking hung.
          onFetch: (tk) => log(`   fetching ${tk}  [cache ${fetchStats.cached} · tv ${fetchStats.tradingview} · poly ${fetchStats.polygon}]`),
        }));
        } catch (e) {
          if (e.code === "NOT_ENTITLED") {
            priced.push({ ...t, skipped: `option data for ${s.date} not on the plan yet (available T+1)` });
          } else throw e;
        }
      }
    }
    rows.push({ rules: rules.id, rulesLabel: rules.label, instrument: inst.id, ...summarise(priced), trades: priced });
  }
  log(`${rules.id.padEnd(20)} ${signalCount} trade(s) across ${sessions.length} session(s)`);
}
await restoreChart();
log(`bars: ${fetchStats.cached} cached, ${fetchStats.tradingview} from TradingView, ${fetchStats.polygon} from Polygon`);

/**
 * INDEPENDENT signals, not the sum across the sweep.
 *
 * The first version summed realisedTrades over every variant and got 224 for a
 * day with ten signals — the same handful re-priced 42 ways — and sailed past
 * the sample-size gate. Count from the RAW stream instead: a BUY is a BUY
 * regardless of which variant would have acted on it, and every variant's entry
 * set is a subset of the BUYs plus the ARMs that never triggered.
 */
const isBuy = (e) => e.signal === "BUY_CALL" || e.signal === "BUY_PUT";
const isArm = (e) => e.signal === "ARM_CALL" || e.signal === "ARM_PUT";
const buys = events.filter(isBuy);
const rthBuys = buys.filter((e) => e.withinRth !== false).length;
const barOf = (e) => (/^\d{2}:\d{2}$/.test(e.barHhmm ?? "") ? e.barHhmm : etHHMM(Date.parse(e.receivedAt)));
const totals = {
  independentSignals: buys.length,
  armSignals: events.filter(isArm).length,
  rthSignals: rthBuys,
  outsideRth: buys.length - rthBuys,
  anomalies: sessions.reduce((s, x) => s + (x.anomalies ?? 0), 0),
  liveClosed: Math.max(0, ...rows.filter((r) => r.rules === "live").map((r) => r.realisedTrades)),
  firstSignal: events.length ? barOf(events[0]) : null,
  lastSignal: events.length ? barOf(events[events.length - 1]) : null,
  rowsAcrossSweep: rows.reduce((s, r) => s + r.realisedTrades, 0),
  variants: rows.length,
};

const table = [
  "| rules | instrument | signals | priced | closed | eod-forced | net $/contract | win% | avg % |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    `| ${r.rules} | ${r.instrument} | ${r.signals} | ${r.priced} | ${r.realisedTrades} | ` +
    `${r.eodForced} | ${r.realisedTrades ? r.netPerContract : "—"} | ${r.winRate ?? "—"} | ${r.avgPct ?? "—"} |`),
].join("\n");

console.log(`\n${table}\n`);

/**
 * The skip tally goes INTO the report, not just the console.
 *
 * It used to be logged and dropped. On the first conviction run every one of 42
 * legs was unpriceable and the reviewer could see the zeros but not the reason,
 * so it had to guess at which failure fired — the tally is the difference
 * between "the rules produced nothing" and "the data never arrived", and those
 * demand opposite responses.
 */
const skips = rows.flatMap((r) => r.trades.filter((t) => t.skipped).map((t) => t.skipped));
const skipTally = {};
for (const s of skips) skipTally[s] = (skipTally[s] ?? 0) + 1;
totals.skipSummary = skips.length
  ? Object.entries(skipTally).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n}x ${r}`).join("; ")
  : "none";
if (skips.length) log(`unpriceable legs: ${totals.skipSummary}`);

const sufficient = totals.independentSignals >= MIN_TRADES;
let narrative;
{
  /**
   * Below the threshold the model is still called, but in MECHANICS-ONLY mode.
   *
   * A flat refusal was the first design. It threw away the most valuable output
   * this agent has produced: on 2026-08-10 the review caught that the sample gate
   * was counting sweep rows instead of independent signals, and that every
   * hold-through variant silently dropped its final open trade. Neither is a
   * performance claim, and neither needs a big sample — but you only get them by
   * letting it read the table. What it must never do is rank variants, so the
   * prompt forbids that outright rather than relying on a hedge.
   */
  log(sufficient
    ? `${totals.independentSignals} independent entries — full interpretation`
    : `only ${totals.independentSignals} independent entries (< ${MIN_TRADES}) — MECHANICS-ONLY review, no performance conclusions`);
  narrative = (await runClaude(buildPrompt(dates, table, totals, !sufficient))).trim();
  if (!sufficient) {
    narrative = `> **Mechanics review only.** ${totals.independentSignals} independent entry signals on ` +
      `${date}; ranking rule variants needs at least ${MIN_TRADES}. Nothing below is a claim about profitability.

` + narrative;
  }
}

const report = {
  date,
  dates,
  sessions: sessions.length,
  generatedAt: new Date().toISOString(),
  minTrades: MIN_TRADES,
  closedTrades: totals.independentSignals,
  sufficient,
  narrative,
  table,
  variants: rows.map(({ trades, ...r }) => r),
  sampleTrades: rows.find((r) => r.rules === "live" && r.instrument === "2d-otm1")?.trades ?? [],
};

if (dryRun) {
  console.log(`\n${narrative}\n`);
  log("dry run — nothing pushed");
  process.exit(0);
}

const res = await fetch(`${cfg.PORTAL_URL}/api/spy-conviction?report=1`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-timer-secret": cfg.PORTAL_TIMER_SECRET },
  body: JSON.stringify({ date, report }),
  signal: AbortSignal.timeout(60_000),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`\n  ERROR  portal rejected the report: HTTP ${res.status} ${JSON.stringify(body)}\n`); process.exit(1); }
log(`report pushed for ${date}`);
console.log(`\n${narrative}\n`);
