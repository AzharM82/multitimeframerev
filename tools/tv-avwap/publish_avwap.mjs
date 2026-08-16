#!/usr/bin/env node
/**
 * TradingView MASTER watchlist -> AVWAP-from-Earnings publisher.
 *
 * For every symbol in the TradingView watchlist named MASTER, reads the
 * 39-minute chart's "VWAP Auto Anchored" study (Anchor Period = Earnings) and
 * reports how far the last CLOSED bar sits from that line, in percent:
 *
 *     pct = (close - avwap) / avwap * 100      (+ above / - below)
 *
 * then POSTs the whole sweep to:
 *   POST {API_BASE}/api/avwap-earnings   (header x-timer-secret)
 *
 * Chart truth: the anchored VWAP comes off the live chart. The cloud never
 * re-derives it — the anchor is TradingView's own earnings-date series.
 *
 * How it reads the chart: TradingView Desktop runs with
 * --remote-debugging-port=9222 (same setup the tv-regime publisher in StockAgentHub uses). The study
 * plot series lives in the chart model, not the DOM, so we evaluate against
 * window._exposed_chartWidgetCollection over a raw CDP WebSocket.
 * Dependency-free: Node >= 22 (built-in WebSocket + fetch).
 *
 * Safety properties (this publisher DRIVES the chart symbol ~193 times, unlike
 * every other chart reader on DESKTOP2, which only read):
 *   - LOCK FILE      : refuses to start if another sweep (or another chart
 *                      driver that takes the same lock) is running.
 *   - DEDICATED TAB  : binds the CDP target whose URL matches TV_CHART_URL when
 *                      set, so the sweep never commandeers the chart another
 *                      tool is reading.
 *   - FAIL CLOSED    : verifies the resolution AND that all four levels resolve
 *                      to real study plots BEFORE sweeping. A misconfigured
 *                      chart publishes nothing.
 *   - RESTORES SYMBOL: puts the original symbol back when done (even on error).
 *   - REPORTS FAILURES: symbols it could not read are published in `failed`, so
 *                      a dead feed can never look like a quiet market.
 *
 * Config (.env next to this file, or environment):
 *   API_BASE=https://salmon-river-0a7a0c30f.1.azurestaticapps.net
 *   TIMER_SECRET=...              # same TIMER_SECRET app setting as the SWA
 *   TV_CDP_PORT=9222
 *   TV_WATCHLIST=MASTER
 *   TV_CHART_URL=                 # optional: bind only this chart URL/id
 *   TV_EXPECT_RESOLUTION=39
 *   TV_SYMBOL_TIMEOUT_MS=12000
 *
 * Run:  node publish_avwap.mjs [--force] [--dry-run] [--limit N]
 * Task Scheduler: setup_publisher_task.ps1 (every 5 min, market hours)
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { INSTALL, jsPreflight, jsWatchlist, jsSweep, jsRestoreSymbol } from "./chart_js.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no deps) ──────────────────────────────────────────────
try {
  for (const line of readFileSync(join(HERE, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env — rely on environment */ }

const API_BASE = (process.env.API_BASE || "https://salmon-river-0a7a0c30f.1.azurestaticapps.net").replace(/\/$/, "");
const TIMER_SECRET = process.env.TIMER_SECRET || "";
const CDP_PORT = Number(process.env.TV_CDP_PORT || 9222);
const WATCHLIST = process.env.TV_WATCHLIST || "MASTER";
const CHART_URL = process.env.TV_CHART_URL || "";
const EXPECT_RES = String(process.env.TV_EXPECT_RESOLUTION || "39");
const SYMBOL_TIMEOUT_MS = Number(process.env.TV_SYMBOL_TIMEOUT_MS || 12000);
const LOCK_PATH = join(HERE, ".sweep.lock");
const LOCK_STALE_MS = 15 * 60 * 1000;

const args = process.argv.slice(2);
const flags = new Set(args);
const FORCE = flags.has("--force");
const DRY = flags.has("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 0;
})();

// ── market hours gate (9:25 AM – 4:05 PM ET) ────────────────────────────────
function inMarketWindow() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 25 && mins <= 16 * 60 + 5;
}

// ── lock ────────────────────────────────────────────────────────────────────
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    let stale = false;
    try {
      const info = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
      stale = Date.now() - Number(info.at || 0) > LOCK_STALE_MS;
      if (!stale) {
        console.error(`ERROR: another sweep holds the lock (pid ${info.pid}, started ${info.iso}). ` +
                      `Delete ${LOCK_PATH} if that process is gone.`);
        return false;
      }
      console.warn("WARN: stale lock found — taking it over.");
    } catch {
      stale = true;
    }
    if (stale) { try { rmSync(LOCK_PATH); } catch {} }
  }
  writeFileSync(LOCK_PATH, JSON.stringify({
    pid: process.pid, at: Date.now(), iso: new Date().toISOString(),
  }));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch {}
}

// ── CDP plumbing: ONE persistent WebSocket for the whole sweep ─────────────
// Rebinding per symbol was measured as the bulk of switch latency in the MTF
// sidecar work — hold the session open and reuse it.
async function findChartTarget() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const pages = targets.filter((t) => t.type === "page");
  if (CHART_URL) {
    const bound = pages.find((t) => t.url && t.url.includes(CHART_URL));
    if (!bound) {
      throw new Error(`TV_CHART_URL="${CHART_URL}" matched no open chart tab. ` +
                      `Open that chart on DESKTOP2 first (this publisher will not ` +
                      `commandeer whatever chart happens to be bound).`);
    }
    return bound;
  }
  return pages.find((t) => /tradingview\.com\/chart/i.test(t.url)) ||
         pages.find((t) => /tradingview/i.test(t.url)) ||
         null;
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 20000);
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP ws error: ${e.message || e}`)); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.result?.exceptionDetails) {
          p.reject(new Error(msg.result.exceptionDetails.exception?.description || "JS evaluation error"));
        } else {
          p.resolve(msg.result?.result?.value);
        }
      };
      ws.onclose = () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("CDP socket closed")); }
        this.pending.clear();
      };
    });
  }

  evaluate(expression, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP evaluate timeout (id ${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({
        id, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
  }

  close() { try { this.ws?.close(); } catch {} }
}

// ── main ────────────────────────────────────────────────────────────────────
async function run() {
  if (!FORCE && !inMarketWindow()) {
    console.log("Outside market window (9:25–16:05 ET weekdays). --force to bypass.");
    return 0;
  }
  if (!TIMER_SECRET && !DRY) {
    console.error("ERROR: TIMER_SECRET not set (.env)");
    return 1;
  }

  let target;
  try {
    target = await findChartTarget();
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  if (!target) {
    console.error(`ERROR: TradingView CDP not reachable on :${CDP_PORT} or no chart target found. ` +
                  "TradingView Desktop must have been LAUNCHED with --remote-debugging-port " +
                  "(the flag only applies at launch — an already-running app cannot be attached to).");
    return 2;
  }

  const session = new CdpSession(target.webSocketDebuggerUrl);
  let originalSymbol = "";
  try {
    await session.connect();

    // ── Preflight: fail closed on a misconfigured chart ────────────────
    // INSTALL first: the preflight reports level resolution, which lives in the
    // installed helpers. A level that will not resolve must stop the run here,
    // not surface as a plausible number 193 symbols later.
    await session.evaluate(INSTALL);
    const pre = await session.evaluate(jsPreflight(EXPECT_RES));
    if (!pre || pre.err) {
      console.error(`ERROR: chart preflight failed: ${pre?.err || "no response"}`);
      return 3;
    }
    originalSymbol = pre.symbol || "";
    if (String(pre.resolution) !== EXPECT_RES) {
      console.error(`ERROR: chart is on resolution "${pre.resolution}", expected "${EXPECT_RES}". ` +
                    "Refusing to publish — a wrong-timeframe sweep is worse than no sweep.");
      return 4;
    }
    const resolved = pre.resolve;
    if (!resolved || resolved.errors?.length) {
      console.error("ERROR: could not resolve every level off the chart:");
      for (const e of resolved?.errors || ["no resolution report"]) console.error(`  - ${e}`);
      console.error("Refusing to publish. Run `node inventory.mjs` to see what is actually on the chart.");
      return 4;
    }
    const missing = ["avwap", "sma50", "ema21d", "sma50d"].filter((k) => !resolved.levels[k]);
    if (missing.length) {
      console.error(`ERROR: levels unresolved: ${missing.join(", ")}. Refusing to publish.`);
      return 4;
    }
    console.log(`Chart OK: ${pre.symbol} @ ${pre.resolution}m`);
    for (const k of ["avwap", "sma50", "ema21d", "sma50d"]) {
      const L = resolved.levels[k];
      console.log(`  ${k.padEnd(7)} ${L.desc}  (plot idx ${L.valueIdx}) last=${L.lastValue}`);
    }

    // ── Watchlist ──────────────────────────────────────────────────────
    const wl = await session.evaluate(jsWatchlist(WATCHLIST), 30000);
    if (!wl || wl.error) {
      console.error(`ERROR: watchlist "${WATCHLIST}" not found. Available: ${(wl?.names || []).join(", ")}`);
      return 5;
    }
    let symbols = wl.symbols || [];
    if (LIMIT > 0) symbols = symbols.slice(0, LIMIT);
    if (symbols.length === 0) {
      console.error(`ERROR: watchlist "${WATCHLIST}" is empty`);
      return 5;
    }
    console.log(`Watchlist ${wl.name} (${wl.id}): ${symbols.length} symbols`);

    // ── Sweep ──────────────────────────────────────────────────────────
    const t0 = Date.now();
    // Generous ceiling: ~1.3s/symbol observed, plus slack for cold symbols.
    const sweepTimeout = Math.max(120000, symbols.length * (SYMBOL_TIMEOUT_MS + 2000));
    const resSeconds = Number(EXPECT_RES) * 60;
    const out = await session.evaluate(jsSweep(symbols, SYMBOL_TIMEOUT_MS, resSeconds), sweepTimeout);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (out?.fatal) {
      console.error("ERROR: sweep aborted - the CHART is wrong, so every remaining symbol " +
                    "would be wrong the same way:");
      for (const e of out.fatal) console.error(`  - ${e}`);
      return 4;
    }
    const rows = out?.rows || [];
    const failed = out?.failed || [];
    console.log(`Swept ${rows.length}/${symbols.length} in ${secs}s` +
                (failed.length ? ` · FAILED: ${failed.join(", ")}` : ""));

    if (rows.length === 0) {
      console.error("ERROR: sweep produced no readable rows — not publishing");
      return 6;
    }

    // All rows should share one closed bar; report it if they don't.
    const barTimes = [...new Set(rows.map((r) => r.time))].sort();
    if (barTimes.length > 1) {
      console.warn(`WARN: sweep spans ${barTimes.length} bar times — a bar closed mid-sweep`);
    }
    const barUtc = new Date(barTimes[barTimes.length - 1] * 1000).toISOString();

    const r4 = (v) => (typeof v === "number" && isFinite(v) ? Number(v.toFixed(4)) : null);
    const LEVELS = ["avwap", "sma50", "ema21d", "sma50d"];
    const payload = {
      bar_utc: barUtc,
      published_at: new Date().toISOString(),
      host: hostname(),
      resolution: EXPECT_RES,
      watchlist: wl.name,
      levels: LEVELS,
      failed,
      // Each row carries the LIVE bar (what the tab shows) and, per level, the
      // last two CLOSED bars (what the alert is decided on). See chart_js.mjs.
      rows: rows.map((r) => {
        const o = {
          ticker: r.ticker,
          close: r.close,
          last_bar_closed: !!r.lastBarClosed,
          closed_time: r.closedTime,
          prev_time: r.prevTime,
          closed_close: r.closedClose,
          prev_close: r.prevClose,
        };
        for (const k of LEVELS) {
          const L = r.levels[k];
          o[k] = L ? r4(L.value) : null;
          o["pct_" + k] = L ? L.pct : null;
          o["c_pct_" + k] = L ? L.cPct : null;
          o["p_pct_" + k] = L ? L.pPct : null;
        }
        return o;
      }),
    };

    if (DRY) {
      console.log(`(dry-run: not publishing) bar=${barUtc}`);
      const sorted = [...payload.rows].sort((a, b) => b.pct_avwap - a.pct_avwap);
      console.log("  top:", sorted.slice(0, 5).map((r) => `${r.ticker} ${r.pct_avwap}%`).join(", "));
      console.log("  bottom:", sorted.slice(-5).map((r) => `${r.ticker} ${r.pct_avwap}%`).join(", "));
      return 0;
    }

    const resp = await fetch(`${API_BASE}/api/avwap-earnings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-timer-secret": TIMER_SECRET },
      body: JSON.stringify(payload),
    });
    const res = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error(`ERROR: publish failed ${resp.status}: ${JSON.stringify(res)}`);
      return 7;
    }
    const crossings = res?.crossings || [];
    console.log(`Published ${res?.stored} rows.` +
                (crossings.length
                  ? ` CROSSINGS: ${crossings.map((c) => `${c.ticker} ${c.level} ${c.direction}`).join(", ")}`
                  : " No crossings."));
    return 0;
  } finally {
    // Always hand the chart back the way we found it.
    if (originalSymbol) {
      try {
        await session.evaluate(jsRestoreSymbol(originalSymbol), 15000);
        console.log(`Restored chart symbol: ${originalSymbol}`);
      } catch (e) {
        console.error(`WARN: could not restore symbol ${originalSymbol}: ${e.message}`);
      }
    }
    session.close();
  }
}

async function main() {
  if (!acquireLock()) return 8;
  try {
    return await run();
  } finally {
    releaseLock();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`FATAL: ${e.message}`);
  releaseLock();
  process.exit(10);
});
