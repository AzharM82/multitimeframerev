/**
 * The end-of-day unusual-options sweep.
 *
 * Runs inside this cron Function App rather than as a portal endpoint for one
 * hard reason: Static Web Apps cuts a managed API request off at 45 seconds,
 * and sweeping the universe against Tradier takes minutes. The portal keeps
 * only the read proxy over the blob this writes.
 *
 * Output, per trading day, into the `uoa-signals` container:
 *   <YYYY-MM-DD>.json   the scan
 *   latest.json         a copy, so the tab has one URL
 *   baselines.json      per-contract volume history, folded forward each run
 *
 * ── What a failure looks like ─────────────────────────────────────────────
 * A symbol that errors is recorded in `failed` and the sweep continues; a scan
 * missing four names is still worth reading. But the run refuses to publish if
 * it could not reach a majority of the universe, because an almost-empty scan
 * is indistinguishable from a quiet market and would quietly teach the operator
 * that nothing is happening. That distinction is the whole reason the previous
 * scanner's silence went unnoticed from July to September.
 */

"use strict";

const { BlobServiceClient } = require("@azure/storage-blob");
const { UNIVERSE, feedSymbol } = require("./universe.js");
const { quotes, expirations, optionChain, calendar } = require("./tradier.js");
const D = require("./detection.js");

const CONTAINER = process.env.UOA_SIGNALS_CONTAINER || "uoa-signals";

/** Publish only if at least this share of the universe was actually scanned. */
const MIN_COVERAGE = 0.6;

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

/** Today in New York. The scan is stamped by the session it belongs to. */
function easternDateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

/**
 * Turn one Tradier chain row into an observation.
 *
 * `last` is the contract's last trade. Where a contract has volume but no
 * print of its own we fall back to the midpoint, so a real sweep is not
 * discarded for a missing tick — but a contract with neither is skipped rather
 * than valued at zero.
 */
function toObservation(row, underlying) {
  const strike = num(row.strike);
  const type = row.option_type === "call" ? "C" : row.option_type === "put" ? "P" : null;
  if (strike === null || type === null || !row.expiration_date) return null;

  const bid = num(row.bid);
  const ask = num(row.ask);
  const mid = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const last = num(row.last);
  const price = last !== null && last > 0 ? last : mid;
  if (price === null || price <= 0) return null;

  const g = row.greeks || null;
  return {
    occSymbol: row.symbol,
    underlying,
    type,
    strike,
    expiry: row.expiration_date,
    todayVolume: num(row.volume) || 0,
    priorOi: num(row.open_interest),
    lastPrice: price,
    bid,
    ask,
    iv: g ? num(g.mid_iv) : null,
    delta: g ? num(g.delta) : null,
  };
}

/**
 * Was the exchange actually open on this date?
 *
 * The timer only fires on weekdays, but weekdays include Thanksgiving and Good
 * Friday. On a closed day every chain still answers — with the PREVIOUS
 * session's volume — so the sweep would happily publish a duplicate of
 * yesterday under today's date and the tab would show the same flow twice as
 * though it had happened again. Asking the exchange calendar costs one call.
 *
 * An unreachable calendar is not a reason to skip a real session, so the check
 * fails open and says so.
 */
async function marketWasOpen(scanDate, log) {
  const [y, m] = [Number(scanDate.slice(0, 4)), Number(scanDate.slice(5, 7))];
  try {
    const days = await calendar(m, y);
    const row = days.find((d) => d.date === scanDate);
    if (!row) {
      log(`UOA: no calendar row for ${scanDate} — proceeding`);
      return true;
    }
    return row.status === "open";
  } catch (err) {
    log(`UOA: calendar lookup failed (${err.message}) — proceeding`);
    return true;
  }
}

/**
 * The published shape.
 *
 * Detection works in camelCase because that is the language the code is written
 * in; the blob is snake_case because that is what every other payload this
 * portal serves looks like, and the tab should not have to know which module
 * produced it. The mapping lives here, in one place, rather than leaking a
 * naming convention across the boundary.
 */
function signalToPayload(s) {
  return {
    occ_symbol: s.occSymbol,
    underlying: s.underlying,
    type: s.type,
    strike: s.strike,
    expiry: s.expiry,
    dte: s.dte,
    spot: s.spot,
    today_volume: s.todayVolume,
    prior_oi: s.priorOi,
    vol_oi_ratio: s.volOiRatio,
    vol_ratio: s.volRatio,
    avg_volume_20d: s.avgVolume20d,
    baseline_days: s.baselineDays,
    last_price: s.lastPrice,
    bid: s.bid,
    ask: s.ask,
    iv: s.iv,
    delta: s.delta,
    notional_premium: s.notionalPremium,
    anomaly_score: s.anomalyScore,
    volume_history: s.volumeHistory,
  };
}

function aggregateToPayload(a) {
  return {
    underlying: a.underlying,
    call_volume: a.callVolume,
    put_volume: a.putVolume,
    total_volume: a.totalVolume,
    call_oi: a.callOi,
    put_oi: a.putOi,
    put_call_ratio: a.putCallRatio,
    notional: a.notional,
  };
}

/**
 * Sweep the universe and publish.
 *
 * `log` is the Functions context logger; the sweep is chatty on purpose,
 * because when it goes wrong the log is the only witness.
 */
async function runScan({ log = console.log, universe = UNIVERSE, thresholds = D.DEFAULT_THRESHOLDS,
  scanDate = easternDateKey(), dryRun = false, force = false } = {}) {
  const started = Date.now();
  log(`UOA scan ${scanDate}: ${universe.length} symbols`);

  if (!force && !(await marketWasOpen(scanDate, log))) {
    log(`UOA: ${scanDate} was not a trading day — nothing to scan`);
    return { published: false, reason: "market_closed", scanDate };
  }

  // Spot for every name first — cheap, batched, and needed for the moneyness
  // filter that keeps far wings out of the results.
  const spot = new Map();
  for (let i = 0; i < universe.length; i += 50) {
    const batch = universe.slice(i, i + 50);
    const back = new Map(batch.map((s) => [feedSymbol(s), s]));
    try {
      for (const q of await quotes([...back.keys()])) {
        const p = num(q.last) ?? num(q.close) ?? num(q.prevclose);
        if (p !== null) spot.set(back.get(q.symbol) || q.symbol, p);
      }
    } catch (err) {
      log(`UOA: quote batch ${i} failed — ${err.message}`);
    }
  }
  log(`UOA: ${spot.size} of ${universe.length} spots`);

  const baselines = await readJson("baselines.json", {});
  const observations = [];
  const signals = [];
  const failed = [];
  // Rejection telemetry. Without it a symbol that quietly stops answering looks
  // exactly like a symbol with nothing going on.
  const noSpot = universe.filter((s) => !spot.has(s));
  const noWindowExpiry = [];
  let scanned = 0;
  let contractsSeen = 0;

  for (const sym of universe) {
    try {
      const all = await expirations(feedSymbol(sym));
      const wanted = all.filter((e) => D.inDteWindow(scanDate, e, thresholds));
      if (!wanted.length) { noWindowExpiry.push(sym); scanned += 1; continue; }

      const px = spot.get(sym) ?? 0;
      for (const expiry of wanted) {
        for (const row of await optionChain(feedSymbol(sym), expiry)) {
          const obs = toObservation(row, sym);
          if (!obs) continue;
          if (!D.inMoneyness(obs.strike, px, thresholds)) continue;
          if (obs.todayVolume <= 0) continue;
          contractsSeen += 1;
          observations.push(obs);
          const withHistory = { ...obs, volumeHistory: baselines[obs.occSymbol] || [] };
          const sig = D.evaluateContract(withHistory, scanDate, px, thresholds);
          if (sig) signals.push(sig);
        }
      }
      scanned += 1;
    } catch (err) {
      failed.push({ symbol: sym, error: String(err.message || err).slice(0, 200) });
      log(`UOA: ${sym} failed — ${err.message}`);
    }
  }

  const coverage = universe.length ? scanned / universe.length : 0;
  const elapsed = Math.round((Date.now() - started) / 1000);
  log(`UOA: scanned ${scanned}/${universe.length} (${Math.round(coverage * 100)}%), ` +
      `${contractsSeen} live contracts, ${signals.length} signals, ${elapsed}s`);

  if (coverage < MIN_COVERAGE) {
    // Refuse to overwrite a good scan with a broken one. The tab keeps showing
    // yesterday, which is honest, instead of an empty list that reads as calm.
    const detail = `coverage ${Math.round(coverage * 100)}% below the ${MIN_COVERAGE * 100}% floor`;
    log(`UOA: NOT PUBLISHING — ${detail}`);
    return { published: false, reason: detail, scanned, failed: failed.length, signals: signals.length };
  }

  signals.sort((a, b) => b.anomalyScore - a.anomalyScore);

  const payload = {
    scan_date: scanDate,
    generated_at: new Date().toISOString(),
    feed: "tradier",
    delayed: false,
    data_note:
      "Real-time OPRA volume against prior-settlement open interest, swept after the close. " +
      "Volume above open interest means more contracts changed hands today than existed at " +
      "yesterday's settlement — new positioning rather than the same contracts circulating. " +
      "The side of the flow is inferred from the contract type, not from the trade tape. " +
      "Mechanical signals, not investment advice.",
    universe_size: universe.length,
    symbols_scanned: scanned,
    contracts_scanned: contractsSeen,
    contracts_fired: signals.length,
    no_spot: noSpot,
    no_window_expiry: noWindowExpiry,
    elapsed_seconds: elapsed,
    thresholds,
    signals: signals.map(signalToPayload),
    aggregates: D.aggregate(observations).slice(0, 40).map(aggregateToPayload),
    failed,
  };

  if (dryRun) {
    log("UOA: dry run — nothing written");
    return { published: false, dryRun: true, scanDate, scanned, contracts: contractsSeen, signals: signals.length, elapsed, payload };
  }

  await writeJson(`${scanDate}.json`, payload);
  await writeJson("latest.json", payload);
  await writeJson("baselines.json", D.updateBaselines(baselines, observations, thresholds));
  log(`UOA: published ${scanDate} — ${signals.length} signals`);

  return { published: true, scanDate, scanned, contracts: contractsSeen, signals: signals.length, elapsed };
}

module.exports = { runScan, toObservation, signalToPayload, aggregateToPayload, easternDateKey, MIN_COVERAGE };
