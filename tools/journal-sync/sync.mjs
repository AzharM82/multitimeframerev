#!/usr/bin/env node
/**
 * Trade Journal sync + summariser. Runs on the trading desktop, not in Azure.
 *
 *   1. read the standalone journal app's stored fills (full history)
 *   2. add a live SnapTrade pull for the recent window (non-persisting)
 *   3. FIFO-match the merged set to price the closes, keep Robinhood from EPOCH
 *   4. push them to the portal
 *   5. pull the notes back down
 *   6. rebuild the 10-point lessons list with the Claude CLI
 *   7. push the list to the portal
 *
 * WHY LOCAL: this is the only place that needs the other app's password, and
 * step 6 uses the Claude CLI against an existing subscription rather than an
 * API key. Neither ever reaches Azure — the portal holds notes and the summary,
 * nothing else. The standalone app is strictly READ-ONLY here: both calls are
 * reads (step 2 passes persist=false), and nothing about it changes.
 *
 * Config comes from journal-sync.env next to this file (see .env.example).
 *
 *   node sync.mjs                       full run
 *   node sync.mjs --no-summary          trades only, skip the Claude call
 *   node sync.mjs --dry-run             fetch and report, write nothing
 *   node sync.mjs --portal http://…     write to a different portal host
 *
 * --portal exists so a change can be exercised against `swa start` on this
 * machine before it reaches the live portal. It is an explicit flag rather than
 * an environment override on purpose: this box carries a stale user-level
 * TIMER_SECRET that already broke one job by silently shadowing its config.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Journal history starts here (user decision 2026-08-08). */
const EPOCH = "2026-08-03";
/** Only Robinhood for now — that is where the trading happens. */
const BROKER = "robinhood";
/** Fidelity's cash sweep shows up as a symbol; it is not a trade. */
const NOT_A_TRADE = new Set(["FCASH", "SPAXX", "QACDS"]);
const MAX_POINTS = 10;
/** How far back the live SnapTrade pull reaches. Short enough to stay well
 *  inside the upstream's request budget, long enough to catch a late-settling
 *  fill or a weekend of missed runs. */
const LOOKBACK_DAYS = 14;

// ── config ──────────────────────────────────────────────────────────────────

function loadEnv() {
  const file = path.join(HERE, "journal-sync.env");
  if (!fs.existsSync(file)) {
    fail(`missing ${file}\n  copy .env.example to journal-sync.env and fill it in`);
  }
  const cfg = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const k of ["JOURNAL_APP_URL", "JOURNAL_APP_PASSWORD", "PORTAL_URL", "PORTAL_TIMER_SECRET"]) {
    if (!cfg[k]) fail(`journal-sync.env is missing ${k}`);
  }
  return cfg;
}

function fail(msg) {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
}

const log = (...a) => console.log(" ", ...a);

// ── steps ───────────────────────────────────────────────────────────────────

const underlyingOf = (ticker) => {
  const t = String(ticker ?? "").trim();
  // Options arrive OCC-style: "AAPL  260807C00315000".
  return (t.includes(" ") ? t.split(/\s+/)[0] : t).toUpperCase();
};

/** The standalone app's stored dataset — full history, every broker. */
async function fetchStoredFills(cfg) {
  const res = await fetch(`${cfg.JOURNAL_APP_URL}/api/trades`, {
    headers: { "x-app-password": cfg.JOURNAL_APP_PASSWORD },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) fail(`journal app /api/trades returned HTTP ${res.status}`);
  return (await res.json()).fills ?? [];
}

/**
 * A live SnapTrade pull for the recent window, WITHOUT persisting.
 *
 * WHY NOT let the other app persist it: its `persist=true` path re-runs FIFO
 * over the entire dataset (6k+ fills) after a 90-day, 10-account pull, which
 * overruns Azure SWA's ~45s backend limit — the platform then returns the
 * plaintext "Backend call failure" and NOTHING is written. That is why every
 * closing fill since the epoch reached us with a null realized_pnl. Scoped to a
 * short window with persist=false the same endpoint answers in ~3s, and we do
 * the matching down here where nothing can time us out. The other app is left
 * exactly as it is — this is a read.
 */
async function fetchFreshWindow(cfg) {
  if (!cfg.JOURNAL_APP_SCAN_SECRET) {
    log("no JOURNAL_APP_SCAN_SECRET — skipping the live pull, using stored fills only");
    return [];
  }
  const to = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const url =
    `${cfg.JOURNAL_APP_URL}/api/snaptrade/sync` +
    `?secret=${encodeURIComponent(cfg.JOURNAL_APP_SCAN_SECRET)}&persist=false&from=${from}&to=${to}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      log(`live pull ${from}..${to}: HTTP ${res.status} — continuing with stored fills`);
      return [];
    }
    const body = await res.json();
    if (body.accountErrors?.length) log(`live pull account errors: ${body.accountErrors.join("; ")}`);
    log(`live pull ${from}..${to}: ${body.fillCount ?? 0} fills`);
    return body.fills ?? [];
  } catch (e) {
    // Non-fatal: yesterday's stored fills still journal fine.
    log(`live pull failed (${e.message}) — continuing with stored fills`);
    return [];
  }
}

/** A position is one contract in one account — the unit FIFO matches within. */
const lotKey = (f) => `${f.account}:${f.asset_type}:${f.ticker}:${f.occ_symbol ?? ""}`;

/**
 * FIFO matcher, ported from the standalone app's api/src/fifo.ts so the numbers
 * agree with what that app shows. Buys open lots; a sell consumes the oldest
 * lots first and books (exit − entry) × qty × multiplier, less fees.
 *
 * Runs over the FULL history on purpose: a position opened before the journal
 * epoch and closed after it can only be priced if its opening lot is in scope.
 *
 * Beyond the P&L it records WHERE a close came from. Realized P&L is dated by
 * the closing fill, so an overnight loss books on the exit day — MSFT's −$42k
 * landed on Wed 8/5 for a position bought Tue 8/4, which reads as a Wednesday
 * mistake when it was Tuesday's. `carried_qty` / `opened_on` let the page say
 * so out loud.
 */
function fifoMatch(fills) {
  const sorted = [...fills].sort((a, b) =>
    String(a.filled_at) < String(b.filled_at) ? -1 : String(a.filled_at) > String(b.filled_at) ? 1 : 0,
  );
  const lotsByKey = new Map();

  for (const f of sorted) {
    const k = lotKey(f);
    if (!lotsByKey.has(k)) lotsByKey.set(k, []);
    const lots = lotsByKey.get(k);
    const mult = f.asset_type === "OPTION" ? 100 : 1;
    const day = String(f.trade_date ?? "");

    if (f.side === "BUY") {
      lots.push({ id: f.id, remaining: f.quantity, price: f.price, day });
      f.realized_pnl = null;
      f.carried_qty = 0;
      f.opened_on = null;
    } else {
      let qtyRemaining = f.quantity;
      let pnl = 0;
      let carried = 0;
      let openedOn = null;
      while (qtyRemaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const used = Math.min(qtyRemaining, lot.remaining);
        pnl += (f.price - lot.price) * used * mult;
        if (lot.day && lot.day < day) {
          carried += used;
          if (openedOn === null || lot.day < openedOn) openedOn = lot.day;
        }
        lot.remaining -= used;
        qtyRemaining -= used;
        if (lot.remaining <= 0) lots.shift();
      }
      pnl -= f.fees ?? 0;
      // A sell with no opening lot in scope is a mystery, not a $0 win: leaving
      // it null keeps it out of the P&L rather than inventing a cost basis.
      f.realized_pnl = qtyRemaining === f.quantity ? null : Math.round(pnl * 100) / 100;
      f.carried_qty = carried;
      f.opened_on = openedOn;
    }
  }
  return sorted;
}

/**
 * How much of each (day, symbol) group was still open when that day closed.
 *
 * Computed HERE, over full history, and stamped onto every fill in the group —
 * the same number repeated, deliberately. The page only ever sees fills from
 * the epoch forward, so it cannot work this out for itself: a position opened
 * before 2026-08-03 is invisible to it. Denormalising costs a few bytes a row
 * and removes a whole class of wrong answer.
 *
 * A group's tail is summed over the contracts that group traded, so "MSFT, 4
 * still open" means four contracts across whatever MSFT strikes were touched.
 */
function stampOpenTails(sorted) {
  const position = new Map(); // lot key -> net open qty
  let day = null;
  let groups = new Map(); // underlying -> { fills, contracts }

  const closeDay = () => {
    for (const g of groups.values()) {
      let open = 0;
      for (const c of g.contracts) open += Math.max(0, position.get(c) ?? 0);
      for (const f of g.fills) f.group_open_qty = open;
    }
    groups = new Map();
  };

  for (const f of sorted) {
    const d = String(f.trade_date ?? "");
    if (day !== null && d !== day) closeDay();
    day = d;

    const c = lotKey(f);
    position.set(c, (position.get(c) ?? 0) + (f.side === "BUY" ? f.quantity : -f.quantity));

    const u = underlyingOf(f.ticker);
    let g = groups.get(u);
    if (!g) {
      g = { fills: [], contracts: new Set() };
      groups.set(u, g);
    }
    g.fills.push(f);
    g.contracts.add(c);
  }
  closeDay();
  return sorted;
}

/** Stored history + the live window (live wins), FIFO-priced, epoch-filtered. */
async function collectFills(cfg) {
  const stored = await fetchStoredFills(cfg);
  const fresh = await fetchFreshWindow(cfg);

  const byId = new Map(stored.map((f) => [f.id, f]));
  let added = 0;
  for (const f of fresh) {
    if (!byId.has(f.id)) added += 1;
    byId.set(f.id, f);
  }
  log(`fills: ${stored.length} stored + ${added} new from the live pull`);

  const priced = stampOpenTails(fifoMatch([...byId.values()]));
  const kept = priced.filter(
    (f) =>
      f.broker === BROKER &&
      String(f.trade_date ?? "") >= EPOCH &&
      !NOT_A_TRADE.has(underlyingOf(f.ticker)),
  );
  log(`kept ${kept.length} (${BROKER}, >= ${EPOCH})`);

  return kept.map((f) => ({
    id: f.id,
    trade_date: f.trade_date,
    ticker: f.ticker,
    underlying: underlyingOf(f.ticker),
    asset_type: f.asset_type,
    side: f.side,
    quantity: f.quantity,
    price: f.price,
    fees: f.fees ?? 0,
    realized_pnl: f.realized_pnl ?? null,
    carried_qty: f.carried_qty ?? 0,
    opened_on: f.opened_on ?? null,
    group_open_qty: f.group_open_qty ?? 0,
    filled_at: f.filled_at ?? "",
    broker: f.broker,
  }));
}

async function pushFills(cfg, fills) {
  const res = await fetch(`${cfg.PORTAL_URL}/api/journal-trades`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timer-secret": cfg.PORTAL_TIMER_SECRET },
    body: JSON.stringify({ fills }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`portal /api/journal-trades returned HTTP ${res.status}: ${JSON.stringify(body)}`);
  log(`pushed to portal: ${body.written} written, ${body.skipped} skipped`);
}

async function fetchNotes(cfg) {
  const res = await fetch(`${cfg.PORTAL_URL}/api/journal-notes?from=${EPOCH}`, {
    headers: { "x-timer-secret": cfg.PORTAL_TIMER_SECRET },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) fail(`portal /api/journal-notes returned HTTP ${res.status}`);
  const body = await res.json();
  return body.notes ?? [];
}

async function fetchSummary(cfg) {
  const res = await fetch(`${cfg.PORTAL_URL}/api/journal-summary`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return [];
  const body = await res.json();
  return body.points ?? [];
}

/**
 * Rebuild the lessons list.
 *
 * The cap is the whole point: a new lesson MERGES INTO or EXTENDS an existing
 * point, never becomes an eleventh. The server enforces it too — a model told
 * "at most 10" will eventually hand back 11.
 */
function buildPrompt(existing, notes, pnlByKey) {
  const current = existing.length
    ? existing.map((p, i) => `${i + 1}. ${p}`).join("\n")
    : "(none yet — this is the first run)";

  const entries = notes
    .map((n) => {
      const pnl = pnlByKey.get(`${n.date}|${n.underlying}`);
      const money = pnl === undefined ? "P&L unknown" : `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`;
      return `[${n.date} ${n.underlying} · ${money}]\n${n.text}`;
    })
    .join("\n\n");

  return `You maintain a trader's running lessons list. It is capped at ${MAX_POINTS} points, permanently.

CURRENT LIST:
${current}

THE TRADER'S NOTES (dictated, so unpunctuated and rambling — read through that):
${entries}

Rewrite the list so it reflects everything in the notes.

Rules:
- Return AT MOST ${MAX_POINTS} points. Never an 11th. If a new lesson does not fit an
  existing point, MERGE the two most similar existing points to make room.
- Prefer EXTENDING an existing point over creating a new one. If the notes repeat a
  lesson, sharpen that point with the new specifics instead of restating it.
- Each point: one or two sentences, concrete and behavioural. Name the tickers or
  setups where they make the lesson real. "Cutting MSFT winners inside 10 minutes
  while letting losers run to the close" beats "manage risk better".
- Base every point ONLY on what the notes actually say. Do not invent lessons from
  the P&L numbers alone, and do not give trading advice the trader did not reach.
- Order by how often the notes touch on it, most recurring first.

Output ONLY a JSON array of strings. No prose, no markdown fence, no keys.`;
}

/**
 * Headless Claude, against the existing subscription — no API key anywhere.
 *
 * The prompt goes in on STDIN, not as an argument. Two reasons, both bites:
 * Windows caps a command line at 8191 characters and this prompt grows with
 * every note; and Node >=20.12 refuses to spawn a `.cmd` shim without a shell
 * (EINVAL, the CVE-2024-27980 fix), while going through a shell would mangle
 * the quoting in a multi-line prompt. Resolving the real `claude.exe` and
 * piping sidesteps both.
 */
function runClaude(prompt) {
  const bin = process.platform === "win32" ? "claude.exe" : "claude";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("claude timed out after 5 min")); }, 300_000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not run ${bin}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`));
      resolve(out);
    });
    child.stdin.end(prompt, "utf8");
  });
}

/** Models like to wrap JSON in prose or a fence; dig the array out regardless. */
function parsePoints(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, MAX_POINTS);
  } catch {
    return null;
  }
}

async function pushSummary(cfg, points, noteCount) {
  const res = await fetch(`${cfg.PORTAL_URL}/api/journal-summary`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timer-secret": cfg.PORTAL_TIMER_SECRET },
    body: JSON.stringify({ points, noteCount }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`portal /api/journal-summary returned HTTP ${res.status}: ${JSON.stringify(body)}`);
  log(`summary pushed: ${body.points} points`);
}

// ── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const noSummary = args.has("--no-summary");
const portalOverride = argv.includes("--portal") ? argv[argv.indexOf("--portal") + 1] : null;

/**
 * Exercise the Claude CLI + prompt + parser against synthetic notes, writing
 * nothing anywhere. This is how you check the summariser works on a new machine
 * without putting invented reflections into a real journal.
 */
if (args.has("--self-test")) {
  const notes = [
    { date: "2026-08-04", underlying: "MSFT", text: "took the msft calls too early before it reclaimed vwap, added twice on the way down which is the same add mistake as last week, ended up fine but only because the market bailed me out" },
    { date: "2026-08-05", underlying: "SPY", text: "spy puts, held through the bounce hoping it would come back instead of taking the small loss, that turned a manageable loss into a big one" },
    { date: "2026-08-06", underlying: "AAPL", text: "aapl calls sized way too big for a friday, and again i added on the way down, seeing a pattern here with adding to losers" },
  ];
  const pnl = new Map([["2026-08-04|MSFT", 7567.34], ["2026-08-05|SPY", -11373.95], ["2026-08-06|AAPL", -3536.9]]);
  console.log("\n  [SELF TEST] calling the Claude CLI with 3 synthetic notes…\n");
  const out = await runClaude(buildPrompt([], notes, pnl));
  const pts = parsePoints(out);
  if (!pts) fail(`parser could not read the response:\n${out.slice(0, 800)}`);
  console.log(`  parsed ${pts.length} points (cap ${MAX_POINTS}) — ${pts.length <= MAX_POINTS ? "within cap" : "OVER CAP"}\n`);
  pts.forEach((p, i) => console.log(`   ${String(i + 1).padStart(2)}. ${p}`));
  console.log("\n  [SELF TEST] nothing was written.\n");
  process.exit(pts.length > 0 && pts.length <= MAX_POINTS ? 0 : 1);
}

const cfg = loadEnv();
if (portalOverride) {
  if (!/^https?:\/\//.test(portalOverride)) fail(`--portal needs a URL, got "${portalOverride}"`);
  cfg.PORTAL_URL = portalOverride.replace(/\/$/, "");
}
console.log(`\njournal-sync  ${new Date().toISOString()}${dryRun ? "  [DRY RUN]" : ""}`);
console.log(`portal: ${cfg.PORTAL_URL}\n`);

const fills = await collectFills(cfg);

if (fills.length === 0) {
  log("nothing to journal yet");
  process.exit(0);
}

// Realized P&L per (date, underlying) — only closing fills carry it.
const pnlByKey = new Map();
for (const f of fills) {
  if (f.realized_pnl === null || f.realized_pnl === undefined) continue;
  const k = `${f.trade_date}|${f.underlying}`;
  pnlByKey.set(k, (pnlByKey.get(k) ?? 0) + f.realized_pnl);
}
log(`${pnlByKey.size} (day, symbol) groups with realized P&L`);

if (dryRun) {
  for (const [k, v] of [...pnlByKey].sort()) log(`   ${k}  ${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
  log("dry run — nothing written");
  process.exit(0);
}

await pushFills(cfg, fills);

if (noSummary) {
  log("--no-summary — done");
  process.exit(0);
}

const notes = await fetchNotes(cfg);
log(`notes: ${notes.length}`);
if (notes.length === 0) {
  log("no notes yet — nothing to learn from, skipping the summary");
  process.exit(0);
}

const existing = await fetchSummary(cfg);
log(`existing lessons: ${existing.length}`);

const raw = await runClaude(buildPrompt(existing, notes, pnlByKey));
const points = parsePoints(raw);
if (!points || points.length === 0) {
  fail(`could not parse points from the Claude response:\n${raw.slice(0, 600)}`);
}
log(`rebuilt ${points.length} lessons`);
await pushSummary(cfg, points, notes.length);

console.log("\n  done\n");
