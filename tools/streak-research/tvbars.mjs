/**
 * TradingView as an option-bar source, over CDP.
 *
 * WHY IT EXISTS: Polygon will not sell this plan the CURRENT session's option
 * aggregates (403), and throttles the historical ones to ~5 requests a minute.
 * TradingView carries the same OPRA contracts, serves 5-minute bars through the
 * current close, keeps roughly five sessions of intraday history, and answers in
 * ~1.5s. That is the difference between reviewing today after the bell and
 * reviewing yesterday tomorrow.
 *
 * NOT A REPLACEMENT. TradingView does not serve EXPIRED contracts, and a
 * backtest is mostly expired contracts, so simulate.mjs keeps Polygon as the
 * fallback and records which source priced each one.
 *
 * WHAT IT COSTS: this drives the DESKTOP app's single shared chart. It is not a
 * service, it cannot run with the app closed, and a sweep walks the chart
 * through dozens of contracts — so callers save and restore the view, and the
 * job is scheduled for after the close.
 *
 * TWO THINGS THAT COST AN EVENING TO FIND, both of which look identical to a
 * slow chart load:
 *
 *   1. THE SYMBOL NEEDS THE EXCHANGE PREFIX AND A DECIMAL STRIKE.
 *      `OPRA:SPY260812C775.0` resolves; a bare `SPY260812C775` renders "This
 *      symbol doesn't exist" and the series then sits at size 0 forever. It
 *      appeared to work early on only because that one contract had been loaded
 *      by hand, leaving it resolved in the session.
 *
 *   2. SET AND READ MUST BE SEPARATE CDP EVALUATES.
 *      set-symbol, poll, then read inside one long async IIFE NEVER returns
 *      data, however long it waits — the chart does not progress its load while
 *      a single evaluate is outstanding. Driving the poll from Node works first
 *      time, every time.
 *
 * Also: exportData() is a dead end ("Data export is not supported" on this
 * feed). Bars come from activeChart().getSeries().data(), which has
 * size/first/last/valueAt and each((i,row)) with [time,o,h,l,c,v] — and no
 * lastIndex(). The feed is DELAYED (_DLY), so allow time after the close for the
 * final bars to fill.
 */
/**
 * TradingView as an option-bar source, over CDP.
 *
 * WHY IT EXISTS: Polygon will not sell this plan the CURRENT session's option
 * aggregates (403), and throttles the historical ones to ~5 requests a minute.
 * TradingView carries the same OPRA contracts, serves 5-minute bars through the
 * current close, keeps roughly five days of intraday history, and has no rate
 * limit. For an end-of-day report that is strictly better — it is the difference
 * between reviewing today after the bell and reviewing yesterday tomorrow.
 *
 * WHAT IT COSTS: this drives the TradingView DESKTOP app's single shared chart.
 * It is not a service. If the operator is looking at that chart, a sweep will
 * yank it through dozens of symbols. It also cannot run when the app is closed.
 * So it is the PREFERRED source, never the only one — simulate.mjs falls back to
 * Polygon whenever TradingView is unreachable, and records which source priced
 * each contract so a number can always be traced.
 *
 * THE ORDERING RULE, learned the hard way (2026-08-11): a read only returns data
 * when the RESOLUTION is set immediately before it. Setting the symbol alone
 * leaves the extractor looking at the previous symbol's series and it reports
 * "chart may still be loading" indefinitely. Symbol, then resolution, then read
 * — in that order, every time. Four consecutive failures were this, not flakiness.
 */

const PORT = 9222;

/**
 * `O:SPY260812C00775000` -> `OPRA:SPY260812C775.0`
 *
 * THE EXCHANGE PREFIX AND THE DECIMAL ARE BOTH REQUIRED. A bare
 * `SPY260812C775` renders "This symbol doesn't exist" on a chart that has not
 * already resolved that contract, and the series then sits at size 0 forever —
 * which reads exactly like a slow load and cost most of an evening to diagnose.
 * It appeared to work only because the operator had loaded that one contract by
 * hand, leaving it resolved in the session.
 *
 * TradingView normalises `OPRA:` to `OPRA_DLY:` on this (delayed) feed, so we
 * send the plain prefix and let it map. The strike always carries at least one
 * decimal place: 775.0, not 775.
 */
export function toTvSymbol(polygonTicker) {
  const m = String(polygonTicker).replace(/^O:/, "").match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yymmdd, cp, strike8] = m;
  const strike = Number(strike8) / 1000;
  const printed = strike % 1 === 0 ? strike.toFixed(1) : String(strike);
  return `OPRA:${root}${yymmdd}${cp}${printed}`;
}

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  return res.json();
}

/** The TradingView chart tab, not a background/devtools target. */
async function chartTarget() {
  const list = await cdpTargets();
  return list.find((t) => t.type === "page" && /tradingview\.com\/chart/i.test(t.url)) ?? null;
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const s = new Session(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && s.pending.has(msg.id)) { s.pending.get(msg.id)(msg); s.pending.delete(msg.id); }
    };
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP websocket failed"));
      setTimeout(() => rej(new Error("CDP websocket timeout")), 8000);
    });
    await s.send("Runtime.enable");
    return s;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); } }, 45_000);
    });
  }

  /** Evaluate in the page and unwrap, turning page-side throws into real ones. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(`page: ${r.result.exceptionDetails.exception?.description ?? "exception"}`);
    }
    return r.result?.result?.value;
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/** Is TradingView up, with the charting API reachable? */
export async function tvAvailable() {
  try {
    const target = await chartTarget();
    if (!target) return false;
    const s = await Session.open(target.webSocketDebuggerUrl);
    const ok = await s.eval(`typeof window.TradingViewApi !== "undefined" && !!window.TradingViewApi.activeChart`);
    s.close();
    return ok === true;
  } catch {
    return false;
  }
}

/** What the chart was showing, so a sweep can put it back afterwards. */
export async function tvCurrentView() {
  const target = await chartTarget();
  if (!target) return null;
  const s = await Session.open(target.webSocketDebuggerUrl);
  try {
    return await s.eval(`(() => {
      const c = window.TradingViewApi.activeChart();
      return { symbol: c.symbol(), resolution: c.resolution() };
    })()`);
  } finally { s.close(); }
}

export async function tvRestoreView(view) {
  if (!view?.symbol) return;
  const target = await chartTarget();
  if (!target) return;
  const s = await Session.open(target.webSocketDebuggerUrl);
  try {
    await s.eval(`(async () => {
      const c = window.TradingViewApi.activeChart();
      c.setSymbol(${JSON.stringify(view.symbol)});
      c.setResolution(${JSON.stringify(String(view.resolution ?? "5"))});
      return true;
    })()`);
  } finally { s.close(); }
}

/**
 * 5-minute bars for one option contract, as [{t(ms), o,h,l,c,v}].
 *
 * Returns null when TradingView cannot serve it — an unknown symbol, or the
 * chart never producing data. Null means "ask Polygon", never "no trades".
 */
export async function tvOptionBars(tvSymbol, { resolution = "5", tries = 2, timeoutMs = 25_000 } = {}) {
  const target = await chartTarget();
  if (!target) return null;
  const s = await Session.open(target.webSocketDebuggerUrl);
  try {
    for (let attempt = 1; attempt <= tries; attempt++) {
      /**
       * THREE SEPARATE EVALUATES, deliberately.
       *
       * Doing set-then-poll-then-read inside one long async IIFE never returns
       * data, however long it waits — the chart does not appear to progress its
       * load while a single evaluate is outstanding. Split into discrete calls,
       * with the polling driven from Node, it works first time. Every "chart may
       * still be loading" failure tonight was this, plus a bad symbol format.
       */
      await s.eval(`(() => {
        const c = window.TradingViewApi.activeChart();
        c.setSymbol(${JSON.stringify(tvSymbol)});
        c.setResolution(${JSON.stringify(resolution)});
        return true;
      })()`);

      const deadline = Date.now() + timeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 800));
        const state = await s.eval(`(() => {
          try {
            const c = window.TradingViewApi.activeChart();
            return { sym: String(c.symbol()), size: c.getSeries().data().size() };
          } catch (e) { return { sym: "", size: -1 }; }
        })()`);
        const norm = (x) => String(x).toUpperCase().replace(/[^A-Z0-9.]/g, "");
        // Compare on the bare contract: we send OPRA:..., it resolves OPRA_DLY:...
        const bare = norm(tvSymbol).replace(/^OPRA(DLY)?/, "");
        if (state && state.size > 0 && norm(state.sym).includes(bare)) { ready = true; break; }
      }
      if (!ready) continue;

      const bars = await s.eval(`(() => {
        const d = window.TradingViewApi.activeChart().getSeries().data();
        const out = [];
        // each() has no lastIndex sibling and STOPS on a truthy return.
        d.each((i, row) => {
          if (row && row.length >= 5) out.push({ t: row[0] * 1000, o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] ?? 0 });
          return false;
        });
        return out;
      })()`);
      if (bars && bars.length) return bars;
    }
    return null;
  } finally {
    s.close();
  }
}
