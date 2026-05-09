import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { listByPartition, upsert, remove, TABLES } from "../lib/tables.js";
import { fetchAllSnapshots, type SnapshotTicker } from "../lib/polygonSnapshot.js";

interface BullListRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  entry: number;
  sl: number;
  tp: number;
  rPct: number;
  status: "OPEN" | "TP_HIT" | "SL_HIT" | "EXPIRED";
  addedAt: string;
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  source: string;
  emailSubject: string;
  reversalBarTs: string;
}

const EXPIRY_TRADING_DAYS = 10;

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

function pickPrice(s: SnapshotTicker | undefined): number | null {
  if (!s) return null;
  return s.min?.c || s.lastTrade?.p || s.day?.c || s.prevDay?.c || null;
}

async function moveToClosed(row: BullListRow, exitPrice: number, exitReason: BullListRow["status"]): Promise<void> {
  const closed: BullListRow = {
    ...row,
    partitionKey: "closed",
    status: exitReason,
    closedAt: new Date().toISOString(),
    exitPrice,
    exitReason,
  };
  await upsert(TABLES.BULL_LIST, "closed", row.rowKey, closed);
  await remove(TABLES.BULL_LIST, "open", row.rowKey);
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
    const open = await listByPartition<BullListRow>(TABLES.BULL_LIST, "open");
    ctx.log(`bullMonitorTimer: ${open.length} open positions`);

    const tickers = Array.from(new Set(open.map((r) => r.ticker)));
    const snapshots = tickers.length > 0
      ? await fetchAllSnapshots(tickers).catch((err) => {
          ctx.error(`snapshot fetch failed: ${err instanceof Error ? err.message : String(err)}`);
          return new Map<string, SnapshotTicker>();
        })
      : new Map<string, SnapshotTicker>();

    const transitions: { ticker: string; reason: string; price: number }[] = [];
    const errors: { ticker: string; error: string }[] = [];
    let skipped = 0;

    for (const row of open) {
      try {
        const last = pickPrice(snapshots.get(row.ticker));
        if (last === null) {
          skipped++;
          continue;
        }

        if (last <= row.sl) {
          await moveToClosed(row, last, "SL_HIT");
          transitions.push({ ticker: row.ticker, reason: "SL_HIT", price: last });
          continue;
        }
        if (last >= row.tp) {
          await moveToClosed(row, last, "TP_HIT");
          transitions.push({ ticker: row.ticker, reason: "TP_HIT", price: last });
          continue;
        }
        const days = tradingDaysSince(row.addedAt);
        if (days >= EXPIRY_TRADING_DAYS) {
          await moveToClosed(row, last, "EXPIRED");
          transitions.push({ ticker: row.ticker, reason: "EXPIRED", price: last });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        ctx.error(`bullMonitorTimer ${row.ticker}: ${message}`);
        errors.push({ ticker: row.ticker, error: message });
      }
    }

    return {
      jsonBody: {
        status: "ok",
        checked: open.length,
        closed: transitions.length,
        skippedNoPrice: skipped,
        errors: errors.length,
        transitions,
        errorDetails: errors,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`bullMonitorTimer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("bullMonitorTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "bull-monitor-timer",
  handler: bullMonitorHandler,
});
