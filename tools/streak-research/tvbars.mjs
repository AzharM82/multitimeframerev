/**
 * ⚠️ WIP — NOT WIRED IN, NOT WORKING RELIABLY (2026-08-11).
 *
 * Nothing imports this. simulate.mjs still prices exclusively from Polygon.
 * Committed for the API archaeology below, which took a while to establish and
 * would otherwise have to be rediscovered.
 *
 * WHAT IS PROVEN:
 *   - TradingView carries the OPRA contracts (OPRA_DLY:SPY260812C775.0) with
 *     5-minute bars, ~300 of them, spanning roughly five sessions INCLUDING the
 *     current one — which is exactly what Polygon refuses (403 on today).
 *   - The bars are reachable: activeChart().getSeries().data() exposes size(),
 *     first(), last(), valueAt() and each((i,row)=>...) where a row is
 *     [time, open, high, low, close, volume]. There is NO lastIndex().
 *   - exportData() is NOT usable — it throws "Data export is not supported"
 *     for this feed, so the study-collector style accessor is the only way in.
 *   - The feed is DELAYED (_DLY suffix), so a run immediately after the close
 *     may be missing the final bars.
 *
 * WHAT IS NOT SOLVED — the reason this is not wired in:
 *   Extraction fails intermittently even when the series demonstrably holds 300
 *   bars (verified directly: symbol correct, resolution 5, size() === 300, yet
 *   both this reader AND the TradingView MCP return "chart may still be
 *   loading"). So it is the extraction path, not this file's logic. A sweep
 *   needs 40-80 symbol swaps and TradingView stopped responding entirely during
 *   testing at that rate.
 *
 * BEFORE RESUMING: this drives the operator's SINGLE SHARED CHART. Any real
 * version needs its own layout or a headless equivalent — a research job must
 * never fight the human for the screen, and must never be able to take the
 * charting app down.
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

/** `O:SPY260812C00775000` -> `SPY260812C775` (TradingView / OPRA form). */
export function toTvSymbol(polygonTicker) {
  const m = String(polygonTicker).replace(/^O:/, "").match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yymmdd, cp, strike8] = m;
  const strike = Number(strike8) / 1000;
  // TradingView drops trailing zeros: 775, not 775.000.
  return `${root}${yymmdd}${cp}${strike % 1 === 0 ? strike : String(strike).replace(/0+$/, "")}`;
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
export async function tvOptionBars(tvSymbol, { resolution = "5", tries = 3 } = {}) {
  const target = await chartTarget();
  if (!target) return null;
  const s = await Session.open(target.webSocketDebuggerUrl);
  try {
    for (let attempt = 1; attempt <= tries; attempt++) {
      const rows = await s.eval(`(async () => {
        const c = window.TradingViewApi.activeChart();
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const want = ${JSON.stringify(tvSymbol)};

        const norm0 = (x) => String(x).toUpperCase().replace(/[^A-Z0-9.]/g, "");
        const already = norm0(c.symbol()).includes(norm0(want))
          && String(c.resolution()) === ${JSON.stringify(resolution)};

        // Symbol FIRST, resolution SECOND, read THIRD. Setting the resolution
        // is what forces the series to re-resolve; without it the read returns
        // the PREVIOUS symbol's bars, which is far worse than returning none.
        //
        // Skipped entirely when the chart is already there: a redundant
        // setSymbol throws the series back into a reload and costs another
        // multi-second wait for data we could have read immediately.
        if (!already) {
          c.setSymbol(want);
          await wait(700);
          c.setResolution(${JSON.stringify(resolution)});
          await wait(1200);
        }

        // NOT exportData — TradingView answers "Data export is not supported"
        // for this feed. The series' own data accessor is unrestricted.
        // Note it has no lastIndex(); each()/size()/last() are what exist, and
        // each() STOPS when the callback returns truthy.
        const norm = (x) => String(x).toUpperCase().replace(/[^A-Z0-9.]/g, "");
        for (let i = 0; i < 60; i++) {
          try {
            const sym = norm(c.symbol());
            // The resolved symbol carries an exchange prefix and a .0 suffix
            // (OPRA_DLY:SPY260812C775.0), so match on containment, not equality.
            const onTarget = sym.includes(norm(want));
            const d = c.getSeries().data();
            if (onTarget && d && d.size && d.size() > 0) {
              const out = [];
              d.each((idx, row) => {
                if (row && row.length >= 5) {
                  out.push({ t: row[0] * 1000, o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] ?? 0 });
                }
                return false; // falsy = keep iterating
              });
              if (out.length) return { symbol: c.symbol(), bars: out };
            }
          } catch (e) { /* series still swapping */ }
          await wait(500);
        }
        return null;
      })()`);

      if (rows && rows.bars && rows.bars.length) return rows.bars;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1200));
    }
    return null;
  } finally {
    s.close();
  }
}
