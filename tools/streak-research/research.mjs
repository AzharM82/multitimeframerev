#!/usr/bin/env node
/**
 * SPY streak research agent — end of day.
 *
 *   1. read the day's streak events from the portal
 *   2. replay them against REAL SPY option bars under many rule/instrument variants
 *   3. hand the resulting table to the Claude CLI for interpretation
 *   4. push the report back to the portal, where it renders under the SPY Streak tab
 *
 * WHY LOCAL, like tools/journal-sync: step 3 uses the Claude CLI against the
 * existing subscription, so no model key ever reaches Azure.
 *
 * WHAT IT WILL NOT DO: change anything. It reports. A research agent with write
 * access to live trading rules is how a system drifts without anyone deciding to.
 *
 * THE SAMPLE-SIZE GATE IS THE POINT. Streaks have only been recorded since
 * 2026-08-09 and cannot be backfilled — the breadth inputs live on TradingView's
 * side. With a handful of trades, a variant sweep is noise wearing a table's
 * clothes. Below MIN_TRADES the agent is told to say so and stop, because the
 * failure mode we are guarding against already happened once on this stack: the
 * DTSWAI nightly agent spent weeks writing confident reports off an empty
 * dataset, and nobody could tell from the reports.
 *
 *   node research.mjs                 today
 *   node research.mjs --date 2026-08-10
 *   node research.mjs --dry-run       compute + print, push nothing
 *   node research.mjs --portal http://localhost:4280
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { spyBars, pairTrades, priceTrade, summarise, fetchStats, etHHMM } from "./simulate.mjs";
import { tvAvailable, tvCurrentView, tvRestoreView } from "./tvbars.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(" ", ...a);

/** Below this many CLOSED trades the agent reports insufficient data, full stop. */
const MIN_TRADES = 20;

/** The live rules, and the alternatives worth arguing with. */
const RULE_SETS = [
  { id: "live", label: "LIVE: aligned-only, hold through pause, exit on opposite streak",
    exit: "opposite", regimeFilter: "aligned", gateBlocksNo: true },
  { id: "exit-on-end", label: "exit when the streak ends (no holding through a pause)",
    exit: "end", regimeFilter: "aligned", gateBlocksNo: true },
  { id: "no-regime", label: "ignore the regime — trade every streak both ways",
    exit: "opposite", regimeFilter: "off", gateBlocksNo: false },
  { id: "no-regime-exit-end", label: "no regime filter AND exit on streak end",
    exit: "end", regimeFilter: "off", gateBlocksNo: false },
  { id: "allow-neutral", label: "aligned OR neutral regime (trade chop days too)",
    exit: "opposite", regimeFilter: "aligned-or-neutral", gateBlocksNo: true },
  { id: "ignore-gate", label: "aligned-only but ignore a Gate NO",
    exit: "opposite", regimeFilter: "aligned", gateBlocksNo: false },
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
  const res = await fetch(`${cfg.PORTAL_URL}/api/tv-trend-webhook?date=${date}`, {
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
  return `You are reviewing one trading day of a SPY breadth-streak alert system.

The system: a TradingView indicator marks a "streak" when 3 of 4 market-breadth
symbols agree in colour for 3 consecutive 5-minute Heikin-Ashi bars. A streak
start is a candidate entry, a streak end a candidate exit. The live rules trade
ONLY when the streak agrees with the portal's SPY regime (bullish -> calls,
bearish -> puts), hold through a streak ending on a trending day, and exit when
the OPPOSITE streak starts. It alerts a human; it places no orders.

Below, each variant was replayed against REAL SPY option 5-minute bars. Fills are
the next bar's OPEN after the signal. P&L is dollars per single contract.

DATE: ${date}
INDEPENDENT STREAK SIGNALS THIS DAY: ${totals.independentSignals} (trend_start events in the raw stream)
FIRST/LAST SIGNAL (ET): ${totals.firstSignal} / ${totals.lastSignal}
SIGNALS OUTSIDE REGULAR HOURS: ${totals.outsideRth}
(Every row re-prices those same signals under a different rule set and
instrument. ${totals.rowsAcrossSweep} rows across the sweep is NOT
${totals.rowsAcrossSweep} observations.)

${table}

${mechanicsOnly ? `THIS IS A MECHANICS REVIEW ONLY. ${totals.independentSignals} independent signals is
far too few to say anything about profitability. You must NOT rank the variants,
recommend one, or draw any performance conclusion — not even a hedged one.
Report only on correctness: variants that produced identical results (and what
that implies), unpriceable contracts, trades force-closed at the session end,
signals outside regular hours, and anything in the table that looks like a bug
rather than a result. End with what to fix in the code.` : `Write a short report for the trader. Rules:
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
const tvUp = await tvAvailable();
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

console.log(`\nstreak-research  ${date}${dryRun ? "  [DRY RUN]" : ""}`);
console.log(`portal: ${cfg.PORTAL_URL}\n`);
console.log(`option bars: ${tvUp ? "TradingView (same-day) with Polygon fallback" : "Polygon only — TradingView not running, so previous session"}
`);
if (tvUp) savedView = await tvCurrentView().catch(() => null);

const sessions = [];
for (const d of dates) {
  const day = await fetchDay(cfg, d);
  const evs = (day.events ?? []).filter((e) => e.trend && e.event);
  if (evs.length === 0) { log(`${d}: no streak events — skipped`); continue; }
  const bars = await spyBars(d, cfg.POLYGON_API_KEY);
  sessions.push({ date: d, events: evs, spy: bars });
  log(`${d}: ${evs.length} events, ${bars.size} SPY bars`);
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
      const trades = pairTrades(s.events, rules);   // per session, never across days
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
 * day with ten streaks — the same handful of signals re-priced 42 ways — and
 * sailed past the sample-size gate. The widest rule set (no regime filter) is
 * the true count of streak-driven entries the day could offer; every gated
 * variant is a subset of it.
 */
const entryStarts = events.filter((e) => e.event === "trend_start").length;
const rthStarts = events.filter((e) => e.event === "trend_start" && e.withinRth !== false).length;
const totals = {
  // Counted from the RAW event stream, not from any variant. Taking the max over
  // one rule set understated the day: `no-regime` uses exit-on-opposite, whose
  // `if (open) continue` suppresses re-entries that exit-on-end allows, so it is
  // not the widest set. A trend_start is a trend_start regardless of which rule
  // would have acted on it.
  independentSignals: entryStarts,
  rthSignals: rthStarts,
  outsideRth: entryStarts - rthStarts,
  liveClosed: Math.max(0, ...rows.filter((r) => r.rules === "live").map((r) => r.realisedTrades)),
  firstSignal: events.length ? etHHMM(Date.parse(events[0].receivedAt)) : null,
  lastSignal: events.length ? etHHMM(Date.parse(events[events.length - 1].receivedAt)) : null,
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

const skips = rows.flatMap((r) => r.trades.filter((t) => t.skipped).map((t) => t.skipped));
if (skips.length) {
  const tally = {};
  for (const s of skips) tally[s] = (tally[s] ?? 0) + 1;
  log(`unpriceable legs: ${JSON.stringify(tally)}`);
}

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
    ? `${totals.independentSignals} independent signals — full interpretation`
    : `only ${totals.independentSignals} independent signals (< ${MIN_TRADES}) — MECHANICS-ONLY review, no performance conclusions`);
  narrative = (await runClaude(buildPrompt(dates, table, totals, !sufficient))).trim();
  if (!sufficient) {
    narrative = `> **Mechanics review only.** ${totals.independentSignals} independent streak signals on ` +
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

const res = await fetch(`${cfg.PORTAL_URL}/api/tv-trend-webhook?report=1`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-timer-secret": cfg.PORTAL_TIMER_SECRET },
  body: JSON.stringify({ date, report }),
  signal: AbortSignal.timeout(60_000),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`\n  ERROR  portal rejected the report: HTTP ${res.status} ${JSON.stringify(body)}\n`); process.exit(1); }
log(`report pushed for ${date}`);
console.log(`\n${narrative}\n`);
