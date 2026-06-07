import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { listByPartition, upsert, remove, TABLES } from "../lib/tables.js";
import { fetchSnapshotPrices, fetch30mCandles } from "../lib/polygon.js";
import { computeZigZag } from "../lib/indicators.js";

/**
 * Swing List monitor — STAGE 2 of the two-stage execution model.
 *
 * Runs every 30 min during market hours. Three jobs, in order:
 *   1. Expire PENDING signals older than PENDING_EXPIRY_DAYS trading days
 *      (daily reversal never confirmed on the 30m → CANCELLED, no trade).
 *   2. Entry scan (RTH only): for each PENDING ticker, look for a fresh
 *      30-min U1 that printed AFTER the signal arrived. On confirmation,
 *      open the trade at the LIVE snapshot price — a fill you could have
 *      actually gotten — with SL = min low of the 2 bars before the 30m U1
 *      and TP = entry × 1.05.
 *   3. Exit scan: live price vs SL/TP for OPEN trades; EXPIRED after
 *      EXPIRY_TRADING_DAYS.
 */

interface BullListRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  entry?: number;
  sl?: number;
  tp?: number;
  rPct?: number;
  status: "PENDING" | "OPEN" | "TP_HIT" | "SL_HIT" | "EXPIRED" | "CANCELLED";
  addedAt: string;
  confirmedAt?: string;     // when the 30m U1 confirmed and the trade opened
  confirmBarTs?: string;    // timestamp of the confirming 30m U1 bar
  signalBarTs?: string;     // daily U1 bar from the email signal
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  source: string;
  emailSubject: string;
  reversalBarTs?: string;   // legacy field, kept for old rows
}

const EXPIRY_TRADING_DAYS = 10;   // max hold for an OPEN trade
const PENDING_EXPIRY_DAYS = 3;    // max wait for a 30m confirmation
const FRESH_30M_BARS = 2;         // 30m U1 must be within the last N bars

function tradingDaysSince(iso: string): number {
  const start = new Date(iso);
  const now = new Date();
  let count = 0;
  const cur = new Date(start);
  while (cur < now) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// Regular trading hours check (9:30 AM – 4:00 PM ET, weekday).
function isRegularHoursNow(): boolean {
  const now = new Date();
  const weekday = now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  if (weekday === "Sat" || weekday === "Sun") return false;
  const hhmm = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  const [h, m] = hhmm.split(":").map(Number);
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960;
}

async function moveRow(row: BullListRow, fromPartition: string, toPartition: string, patch: Partial<BullListRow>): Promise<void> {
  const next: BullListRow = { ...row, ...patch, partitionKey: toPartition };
  await upsert(TABLES.BULL_LIST, toPartition, row.rowKey, next);
  await remove(TABLES.BULL_LIST, fromPartition, row.rowKey);
}

async function bullMonitorHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  try {
    const [pending, open] = await Promise.all([
      listByPartition<BullListRow>(TABLES.BULL_LIST, "pending"),
      listByPartition<BullListRow>(TABLES.BULL_LIST, "open"),
    ]);
    ctx.log(`bullMonitorTimer: ${pending.length} pending, ${open.length} open`);

    const transitions: { ticker: string; action: string; price?: number }[] = [];

    // ── 1. Expire stale PENDING signals ─────────────────────────────────
    const livePending: BullListRow[] = [];
    for (const row of pending) {
      if (tradingDaysSince(row.addedAt) > PENDING_EXPIRY_DAYS) {
        await moveRow(row, "pending", "closed", {
          status: "CANCELLED",
          exitReason: "NO_30M_CONFIRM",
          closedAt: new Date().toISOString(),
        });
        transitions.push({ ticker: row.ticker, action: "CANCELLED" });
      } else {
        livePending.push(row);
      }
    }

    // ── 2. Entry scan — only during regular trading hours ───────────────
    const rth = isRegularHoursNow();
    if (rth && livePending.length > 0) {
      const openTickers = new Set(open.map((r) => r.ticker));
      const pendingTickers = Array.from(new Set(livePending.map((r) => r.ticker)));
      const livePrices = await fetchSnapshotPrices(pendingTickers);

      for (const row of livePending) {
        if (openTickers.has(row.ticker)) continue;   // never two open positions per ticker

        const last = livePrices.get(row.ticker);
        if (last === undefined) continue;

        let bars;
        try {
          bars = await fetch30mCandles(row.ticker);
        } catch {
          continue;   // Polygon hiccup — retry next cycle
        }
        if (bars.length < 5) continue;

        const zz = computeZigZag(bars);
        let u1Idx = -1;
        for (let i = bars.length - 1; i >= Math.max(0, bars.length - 1 - FRESH_30M_BARS); i--) {
          if (zz[i].U1) { u1Idx = i; break; }
        }
        if (u1Idx === -1) continue;   // no fresh 30m reversal yet — keep waiting

        // Confirmation must come AFTER the signal arrived — a trader can't
        // act on a reversal that printed before they had the signal.
        if (bars[u1Idx].timestamp < new Date(row.addedAt).getTime()) continue;

        // SL = min low of the 2 bars before the 30m U1 ("last 2 bar stop").
        const lows: number[] = [];
        for (let j = Math.max(0, u1Idx - 2); j < u1Idx; j++) lows.push(bars[j].low);
        if (lows.length === 0) continue;
        const sl = Math.min(...lows);

        const entry = last;               // live price — a real, gettable fill
        if (entry <= sl) continue;        // bad geometry — already below stop
        const tp = round2(entry * 1.05);
        const risk = entry - sl;
        const rPct = round2((tp - entry) / risk);

        await moveRow(row, "pending", "open", {
          status: "OPEN",
          entry: round2(entry),
          sl: round2(sl),
          tp,
          rPct,
          confirmedAt: new Date().toISOString(),
          confirmBarTs: new Date(bars[u1Idx].timestamp).toISOString(),
        });
        openTickers.add(row.ticker);
        transitions.push({ ticker: row.ticker, action: "OPENED", price: round2(entry) });
      }
    }

    // ── 3. Exit scan for OPEN trades — RTH only, same as a real stop/limit
    //      order. Premarket prints can't fill a regular stop order.
    const tickers = rth ? Array.from(new Set(open.map((r) => r.ticker))) : [];
    const priceMap = tickers.length > 0 ? await fetchSnapshotPrices(tickers) : new Map<string, number>();
    const skippedNoPrice: string[] = [];

    for (const row of rth ? open : []) {
      const last = priceMap.get(row.ticker);
      if (last === undefined) {
        skippedNoPrice.push(row.ticker);
        continue;
      }
      if (row.sl !== undefined && last <= row.sl) {
        await moveRow(row, "open", "closed", { status: "SL_HIT", exitPrice: last, exitReason: "SL_HIT", closedAt: new Date().toISOString() });
        transitions.push({ ticker: row.ticker, action: "SL_HIT", price: last });
        continue;
      }
      if (row.tp !== undefined && last >= row.tp) {
        await moveRow(row, "open", "closed", { status: "TP_HIT", exitPrice: last, exitReason: "TP_HIT", closedAt: new Date().toISOString() });
        transitions.push({ ticker: row.ticker, action: "TP_HIT", price: last });
        continue;
      }
      const holdSince = row.confirmedAt ?? row.addedAt;
      if (tradingDaysSince(holdSince) >= EXPIRY_TRADING_DAYS) {
        await moveRow(row, "open", "closed", { status: "EXPIRED", exitPrice: last, exitReason: "EXPIRED", closedAt: new Date().toISOString() });
        transitions.push({ ticker: row.ticker, action: "EXPIRED", price: last });
      }
    }

    return {
      jsonBody: {
        status: "ok",
        rth,
        pending: pending.length,
        open: open.length,
        skippedNoPrice: skippedNoPrice.length,
        transitions,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`bullMonitorTimer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

app.http("bullMonitorTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "bull-monitor-timer",
  handler: bullMonitorHandler,
});
