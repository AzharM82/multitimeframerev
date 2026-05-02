import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { fetchAllTimeframes } from "../lib/polygon.js";
import { computeZigZag } from "../lib/indicators.js";
import { listByPartition, getOne, upsert, listAll, TABLES } from "../lib/tables.js";
import { enqueueWhatsApp } from "../lib/queue.js";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const FRESH_BARS = 2; // U1 must have fired within last N 10m bars
const DEDUP_MINUTES = 30;

function getETMinutesOfDay(): number {
  const now = new Date();
  const et = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const [h, m] = et.split(":").map(Number);
  return h * 60 + m;
}

function isWeekday(): boolean {
  const day = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  return !["Sat", "Sun"].includes(day);
}

interface AvwapSummaryRow {
  date: string;
  payload: string;
}

interface AvwapHitRow { ticker: string; pattern: string; score: number }

interface BullListRow { ticker: string; rowKey: string }

async function getCombinedUniverse(): Promise<string[]> {
  const tickers = new Set<string>();

  // From AVWAP latest summary
  try {
    const all = await listAll<AvwapSummaryRow>(TABLES.AVWAP_RESULTS);
    if (all.length > 0) {
      all.sort((a, b) => b.date.localeCompare(a.date));
      const hits = JSON.parse(all[0].payload) as AvwapHitRow[];
      for (const h of hits.slice(0, 30)) tickers.add(h.ticker);
    }
  } catch { /* table may not exist yet */ }

  // From open BullList
  try {
    const open = await listByPartition<BullListRow>(TABLES.BULL_LIST, "open");
    for (const r of open) tickers.add(r.ticker);
  } catch { /* table may not exist yet */ }

  return Array.from(tickers);
}

interface AlertLogRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  reversalPrice: number;
  firedAt: string;
  channel: string;
  status: "QUEUED" | "PUSHOVER_FALLBACK";
}

async function shouldDedup(ticker: string): Promise<boolean> {
  const date = new Date().toISOString().split("T")[0];
  const recent = await listByPartition<AlertLogRow>(TABLES.ALERT_LOG, date);
  const cutoff = Date.now() - DEDUP_MINUTES * 60_000;
  return recent.some((r) => r.ticker === ticker && new Date(r.firedAt).getTime() > cutoff);
}

async function logAlert(ticker: string, reversalPrice: number, channel: AlertLogRow["status"]): Promise<void> {
  const date = new Date().toISOString().split("T")[0];
  const rowKey = `${Date.now()}_${ticker}`;
  await upsert(TABLES.ALERT_LOG, date, rowKey, {
    ticker,
    reversalPrice,
    firedAt: new Date().toISOString(),
    channel: "daytrade",
    status: channel,
  });
}

async function sendPushover(title: string, message: string): Promise<boolean> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return false;
  try {
    const body = new URLSearchParams({ token, user, title, message, priority: "0" });
    const r = await fetch(PUSHOVER_URL, { method: "POST", body });
    return r.ok;
  } catch {
    return false;
  }
}

async function dayTradeHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  if (!isWeekday()) {
    return { jsonBody: { status: "skipped", reason: "weekend" } };
  }

  const minutes = getETMinutesOfDay();
  if (minutes < 570 || minutes > 930) {
    // 9:30 = 570, 15:30 = 930 (skip last 30 mins to avoid late entries)
    return { jsonBody: { status: "skipped", reason: "outside scan window 9:30-15:30 ET" } };
  }

  try {
    const universe = await getCombinedUniverse();
    ctx.log(`dayTradeTimer: scanning ${universe.length} tickers`);

    const fired: { ticker: string; reversalPrice: number; channel: string }[] = [];
    const queueAvailable = !!process.env.AZURE_STORAGE_CONNECTION_STRING;
    const receiver = process.env.WHATSAPP_RECEIVER;

    for (const ticker of universe) {
      try {
        const tf = await fetchAllTimeframes(ticker);
        const m10 = tf.m10;
        if (m10.length < 30) continue;

        const zz = computeZigZag(m10);
        const lastBars = zz.slice(-FRESH_BARS);
        const u1 = lastBars.find((b) => b.U1);
        if (!u1) continue;

        if (await shouldDedup(ticker)) continue;

        const reversalPrice = u1.reversalPrice ?? m10[m10.length - 1].close;
        const text = `📈 ${ticker} 10m bullish reversal — entry near $${reversalPrice.toFixed(2)}`;
        const title = `Day-Trade: ${ticker}`;

        let channel: AlertLogRow["status"] = "QUEUED";
        let queued = false;
        if (queueAvailable && receiver) {
          try {
            await enqueueWhatsApp({ to: receiver, text, meta: { ticker, reversalPrice } });
            queued = true;
          } catch (err) {
            ctx.warn(`enqueueWhatsApp failed for ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (!queued) {
          await sendPushover(title, text);
          channel = "PUSHOVER_FALLBACK";
        }

        await logAlert(ticker, reversalPrice, channel);
        fired.push({ ticker, reversalPrice, channel });
      } catch (err) {
        ctx.warn(`dayTradeTimer ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      jsonBody: {
        status: "ok",
        scanned: universe.length,
        fired: fired.length,
        alerts: fired,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`dayTradeTimer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("dayTradeTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "day-trade-timer",
  handler: dayTradeHandler,
});

// Helper unused but keep for future use
void getOne;
