/**
 * The intraday engine: watch set before the open, poll every two minutes
 * during the session.
 *
 * The end-of-day sweep in scan.js answers "what happened today". This answers
 * "what is happening now", which is the question that has a trade attached to
 * it. Two jobs:
 *
 *   buildWatchSet()  once, pre-open. Walks the chains — the expensive part —
 *                    and writes every contract worth watching, with the open
 *                    interest it carried into the session.
 *   poll()           every two minutes. One form POST per thousand contracts
 *                    returns the whole watch set's running volume, so a poll
 *                    costs a handful of requests instead of one per underlying.
 *
 * Splitting it this way is what makes live affordable: the 600-odd chain calls
 * happen once, while StockAgentHub's executor is asleep, and the session-long
 * polling costs about seven requests a minute against a shared 120.
 *
 * The watch set excludes contracts whose open interest is under the floor.
 * They can never produce a burst — the rule needs a measurable denominator —
 * so carrying them would cost polling budget to learn nothing.
 */

"use strict";

const { BlobServiceClient } = require("@azure/storage-blob");
const { UNIVERSE, feedSymbol } = require("./universe.js");
const { quotes, quotesPost, expirations, optionChain, calendar, setPace } = require("./tradier.js");
const { DEFAULT_BURST, detectBursts, snapshot } = require("./burst.js");
const { dte, inMoneyness } = require("./detection.js");
const { DEFAULT_ALERT, selectAlerts, formatMessage, markSent } = require("./alerts.js");
const { notifyBoth, notifyConfigured } = require("./notify.js");

const CONTAINER = process.env.UOA_SIGNALS_CONTAINER || "uoa-signals";

const LIVE = {
  /** Expiries near enough that intraday positioning shows up in them. */
  dteMin: 3,
  dteMax: 45,
  /** Nearest N expiries per symbol — the cap that keeps the build under ten minutes. */
  maxExpiries: 4,
  moneynessPct: 0.2,
  /** Contracts per quote POST. 1,164 went through in 258 ms in testing. */
  chunk: 900,
  /** Pre-open, the whole rate limit is ours. During the session it is not. */
  buildPaceMs: 520,
  pollPaceMs: 700,
  /** Bursts kept in the session list. */
  sessionCap: 300,
};

function container() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set on the cron Function App");
  return BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
}

async function readJson(name, fallback) {
  try {
    const buf = await container().getBlobClient(name).downloadToBuffer();
    return JSON.parse(buf.toString("utf-8"));
  } catch (err) {
    if (err && err.statusCode === 404) return fallback;
    throw err;
  }
}

async function writeJson(name, body) {
  const c = container();
  await c.createIfNotExists();
  const text = JSON.stringify(body);
  await c.getBlockBlobClient(name).upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(d);

/** Minutes past midnight, Eastern. The session gate is expressed in these. */
function etMinutes(d = new Date()) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

async function marketOpenToday(day, log) {
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  try {
    const row = (await calendar(m, y)).find((d) => d.date === day);
    if (!row) { log(`UOA live: no calendar row for ${day} — proceeding`); return true; }
    return row.status === "open";
  } catch (err) {
    log(`UOA live: calendar lookup failed (${err.message}) — proceeding`);
    return true;
  }
}

/**
 * Walk the chains and write the day's watch set.
 *
 * Runs pre-open, so the open interest it records is yesterday's settlement —
 * which is the correct denominator all day, because OCC only recomputes it
 * overnight. Nothing here changes intraday, which is precisely why it is worth
 * paying for once.
 */
async function buildWatchSet({ log = console.log, universe = UNIVERSE, day = etDate(), force = false } = {}) {
  const started = Date.now();
  setPace(LIVE.buildPaceMs);

  if (!force && !(await marketOpenToday(day, log))) {
    log(`UOA live: ${day} is not a trading day — no watch set`);
    return { built: false, reason: "market_closed", day };
  }

  log(`UOA watch set ${day}: ${universe.length} symbols, ${LIVE.dteMin}-${LIVE.dteMax} DTE`);

  const spot = {};
  for (let i = 0; i < universe.length; i += 50) {
    const batch = universe.slice(i, i + 50);
    const back = new Map(batch.map((s) => [feedSymbol(s), s]));
    try {
      for (const q of await quotes([...back.keys()])) {
        const p = num(q.last) ?? num(q.close) ?? num(q.prevclose);
        if (p !== null) spot[back.get(q.symbol) || q.symbol] = p;
      }
    } catch (err) {
      log(`UOA watch set: quote batch ${i} failed — ${err.message}`);
    }
  }

  const contracts = {};
  const failed = [];
  let symbols = 0;
  let considered = 0;

  for (const sym of universe) {
    try {
      const all = await expirations(feedSymbol(sym));
      const wanted = all
        .filter((e) => { const d = dte(day, e); return d >= LIVE.dteMin && d <= LIVE.dteMax; })
        .slice(0, LIVE.maxExpiries);
      if (!wanted.length) { symbols += 1; continue; }

      const px = spot[sym] ?? 0;
      for (const expiry of wanted) {
        for (const row of await optionChain(feedSymbol(sym), expiry)) {
          const strike = num(row.strike);
          const type = row.option_type === "call" ? "C" : row.option_type === "put" ? "P" : null;
          if (strike === null || type === null) continue;
          considered += 1;
          if (!inMoneyness(strike, px, { moneynessPct: LIVE.moneynessPct })) continue;
          const oi = num(row.open_interest);
          // Below the floor a burst can never be measured, so watching it would
          // spend polling budget to learn nothing.
          if (oi === null || oi < DEFAULT_BURST.oiFloor) continue;
          const g = row.greeks || null;
          contracts[row.symbol] = {
            occSymbol: row.symbol,
            underlying: sym,
            type,
            strike,
            expiry,
            dte: dte(day, expiry),
            priorOi: oi,
            iv: g ? num(g.mid_iv) : null,
            delta: g ? num(g.delta) : null,
          };
        }
      }
      symbols += 1;
    } catch (err) {
      failed.push({ symbol: sym, error: String(err.message || err).slice(0, 200) });
      log(`UOA watch set: ${sym} failed — ${err.message}`);
    }
  }

  const size = Object.keys(contracts).length;
  const elapsed = Math.round((Date.now() - started) / 1000);
  log(`UOA watch set: ${symbols}/${universe.length} symbols, ${considered} contracts seen, ${size} watched, ${elapsed}s`);

  if (!size) {
    log("UOA watch set: nothing to watch — NOT overwriting");
    return { built: false, reason: "empty", day, elapsed };
  }

  await writeJson(`watchset-${day}.json`, {
    day, built_at: new Date().toISOString(), symbols, considered, size, elapsed_seconds: elapsed,
    dte_window: [LIVE.dteMin, LIVE.dteMax], moneyness_pct: LIVE.moneynessPct, failed, contracts,
  });
  // A fresh watch set means yesterday's poll state is meaningless.
  await writeJson(`live-state-${day}.json`, { day, seq: 0, at: null, volumes: {}, alerts: { alerted: {}, sent: 0 } });
  return { built: true, day, symbols, watched: size, elapsed };
}

/**
 * One poll: quote the whole watch set, diff against the last poll, publish.
 *
 * Self-gating on purpose. The timer fires across the 9 and 4 o'clock hours and
 * this decides whether the session is actually running, so a schedule change
 * cannot accidentally produce readings from a closed market.
 */
async function poll({ log = console.log, day = etDate(), now = new Date(), force = false,
  alertDryRun = false } = {}) {
  setPace(LIVE.pollPaceMs);

  // UOA_ALERT_TEST=1 sends one clearly-labelled message and does nothing else.
  // It exists so the alert channel can be proven from the deployed app —
  // credentials, queue, sidecar — without waiting for a real burst or faking
  // market data into the tab. Unset it immediately afterwards.
  if ((process.env.UOA_ALERT_TEST || "").trim() === "1") {
    const res = await notifyBoth(
      "Options flow: channel test",
      "This is a test of the Unusual Options alert channel. No flow was detected — " +
      "real alerts name the ticker, the contract and the size. Sent by hand from the cron app.",
      "uoa_flow_test", { day },
    );
    log(`UOA live: alert channel test — ${JSON.stringify(res)}`);
    return { polled: false, reason: "alert_test", ...res };
  }

  const mins = etMinutes(now);
  // 9:30 to 16:00 ET. Nothing before the open: the first poll of the day has no
  // previous reading, so it would report the entire pre-market as one burst.
  if (!force && (mins < 570 || mins > 960)) {
    return { polled: false, reason: "outside_session", etMinutes: mins };
  }

  const ws = await readJson(`watchset-${day}.json`, null);
  if (!ws || !ws.contracts) {
    log(`UOA live: no watch set for ${day} — the pre-open build did not run`);
    return { polled: false, reason: "no_watchset", day };
  }

  const state = await readJson(`live-state-${day}.json`, { day, seq: 0, at: null, volumes: {}, alerts: { alerted: {}, sent: 0 } });
  const symbols = Object.keys(ws.contracts);
  const started = Date.now();

  const rows = [];
  for (let i = 0; i < symbols.length; i += LIVE.chunk) {
    try {
      for (const q of await quotesPost(symbols.slice(i, i + LIVE.chunk))) {
        rows.push({ symbol: q.symbol, volume: num(q.volume) || 0, last: num(q.last), bid: num(q.bid), ask: num(q.ask) });
      }
    } catch (err) {
      log(`UOA live: quote chunk ${i} failed — ${err.message}`);
    }
  }

  // A poll that reached only a slice of the watch set would report the missing
  // contracts as silent. Better to skip the window than to publish a partial
  // picture as though it were the whole market.
  if (rows.length < symbols.length * 0.8) {
    log(`UOA live: only ${rows.length}/${symbols.length} quotes came back — skipping this window`);
    return { polled: false, reason: "partial_quotes", got: rows.length, want: symbols.length };
  }

  const first = !state.at;
  const bursts = first ? [] : detectBursts(rows, state.volumes, ws.contracts, DEFAULT_BURST);
  const windowSeconds = state.at ? Math.round((now.getTime() - new Date(state.at).getTime()) / 1000) : null;
  const stamp = new Date().toISOString();

  for (const b of bursts) { b.at = stamp; b.window_seconds = windowSeconds; }

  // ── alerting ────────────────────────────────────────────────────────────
  // Far above the tab's bar, one message per poll, one line per name. The tab
  // is something you look at; this interrupts someone.
  let alerts = state.alerts || { alerted: {}, sent: 0 };
  let alerted = [];
  const alertsOff = (process.env.UOA_ALERTS || "").trim().toLowerCase() === "off";
  if (bursts.length && !alertsOff && notifyConfigured()) {
    const sel = selectAlerts(bursts, alerts, now, DEFAULT_ALERT);
    if (sel.lines.length) {
      const { title, body } = formatMessage(sel.lines, { windowSeconds });
      const res = await notifyBoth(title, body, "uoa_flow", {
        day, seq: (state.seq || 0) + 1, names: sel.lines.map((l) => l.underlying),
      }, { dryRun: alertDryRun });
      // Only count a message that was actually sent. Marking a dry run would
      // silently burn the session cap and the cooldowns for a real session.
      if (!alertDryRun) alerts = markSent(alerts, sel.lines, now);
      alerted = sel.lines.map((l) => l.underlying);
      log(`UOA live: alerted ${alerted.join(", ")} — ${JSON.stringify(res)}`);
    } else if (sel.suppressed) {
      log(`UOA live: ${bursts.length} bursts, alert suppressed (${sel.suppressed})`);
    }
  }

  const prevLive = await readJson(`live-${day}.json`, null);
  const session = [...bursts, ...((prevLive && prevLive.session) || [])].slice(0, LIVE.sessionCap);

  const payload = {
    day,
    updated_at: stamp,
    seq: (state.seq || 0) + 1,
    // The first poll establishes the baseline and deliberately reports nothing:
    // without a previous reading every contract's whole day looks like a burst.
    warming: first,
    window_seconds: windowSeconds,
    watchset_size: symbols.length,
    quoted: rows.length,
    watchset_built_at: ws.built_at,
    thresholds: DEFAULT_BURST,
    bursts,
    session,
    /** Names this poll pushed to the phone, so the tab can show what was sent. */
    alerted,
    alerts_sent: alerts.sent || 0,
    alerts_enabled: !alertsOff && notifyConfigured(),
    elapsed_seconds: Math.round((Date.now() - started) / 1000),
  };

  await writeJson(`live-${day}.json`, payload);
  await writeJson("live.json", payload);
  await writeJson(`live-state-${day}.json`, { day, seq: payload.seq, at: stamp, volumes: snapshot(rows), alerts });

  log(`UOA live #${payload.seq}: ${rows.length} quotes, ${bursts.length} bursts${first ? " (warming)" : ""}, ${payload.elapsed_seconds}s`);
  return { polled: true, seq: payload.seq, quoted: rows.length, bursts: bursts.length, warming: first, alerted };
}

module.exports = { LIVE, buildWatchSet, poll, etDate, etMinutes };
