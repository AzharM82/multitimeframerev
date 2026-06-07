import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { fetchBullAlerts } from "../lib/imap.js";
import { fetchDailyBarsExtended } from "../lib/polygon.js";
import { computeLevels } from "../lib/levels.js";
import { upsert, getOne, listByPartition, TABLES } from "../lib/tables.js";
import { pacificDateKey } from "../lib/dates.js";

/**
 * Swing List ingest — STAGE 1 of the two-stage execution model.
 *
 * A D-Bull-Sig email is a HIGHER-TIMEFRAME (daily) signal, not a trade.
 * This handler only validates the daily reversal is fresh and parks the
 * ticker as PENDING. The actual entry happens in bullMonitorTimer when a
 * fresh 30-min U1 prints during market hours — filled at the live price,
 * never at a back-derived chart price.
 */

interface PendingRow {
  partitionKey: string;
  rowKey: string;
  ticker: string;
  status: "PENDING";
  addedAt: string;        // email receive time
  signalBarTs: string;    // daily U1 bar the signal refers to
  emailSubject: string;
  source: string;
}

interface OpenRowLite {
  rowKey: string;
  ticker: string;
}

function todayKey(): string {
  return pacificDateKey();
}

// A D-Bull-Sig email means a reversal printed on the chart TODAY. If the
// server-side ZigZag's most recent U1 is older than this many daily bars,
// it failed to reproduce the signal that fired the email — skip instead.
const MAX_U1_AGE_BARS = 2;

async function bullEmailHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  try {
    const lookbackParam = req.query.get("lookbackDays");
    const lookbackDays = lookbackParam ? Math.max(1, Math.min(30, parseInt(lookbackParam, 10))) : undefined;
    const debug = req.query.get("debug") === "1";
    const folder = req.query.get("folder") ?? undefined;
    const alerts = await fetchBullAlerts({ lookbackDays, debug, folder });
    ctx.log(`bullEmailTimer: ${alerts.length} alerts (lookbackDays=${lookbackDays ?? "unread-only"}, folder=${folder ?? "INBOX"}, debug=${debug})`);

    if (debug) {
      return { jsonBody: { status: "debug", folder: folder ?? "INBOX", count: alerts.length, subjects: alerts.map((a) => ({ uid: a.uid, receivedAt: a.receivedAt, subject: a.subject })) } };
    }

    const date = todayKey();
    const added: PendingRow[] = [];
    const skipped: { ticker: string; reason: string }[] = [];

    const [pendingRows, openRows] = await Promise.all([
      listByPartition<OpenRowLite>(TABLES.BULL_LIST, "pending"),
      listByPartition<OpenRowLite>(TABLES.BULL_LIST, "open"),
    ]);
    const activeTickers = new Set([...pendingRows, ...openRows].map((r) => r.ticker));

    for (const alert of alerts) {
      const rowKey = `${date}_${alert.ticker}`;
      if (activeTickers.has(alert.ticker)) {
        skipped.push({ ticker: alert.ticker, reason: "already pending or open" });
        continue;
      }
      const existing = await getOne<PendingRow>(TABLES.BULL_LIST, "pending", rowKey);
      if (existing) {
        skipped.push({ ticker: alert.ticker, reason: "already pending today" });
        continue;
      }

      try {
        const bars = await fetchDailyBarsExtended(alert.ticker, 2);
        const levels = computeLevels(alert.ticker, bars);
        if (!levels) {
          skipped.push({ ticker: alert.ticker, reason: "insufficient bars" });
          continue;
        }

        const u1AgeBars = bars.length - 1 - levels.reversalBarIdx;
        if (levels.source !== "u1_lookback" || u1AgeBars > MAX_U1_AGE_BARS) {
          skipped.push({
            ticker: alert.ticker,
            reason: `stale U1 (${levels.reversalBarTs.slice(0, 10)}, ${u1AgeBars} bars old)`,
          });
          continue;
        }

        const row: PendingRow = {
          partitionKey: "pending",
          rowKey,
          ticker: alert.ticker,
          status: "PENDING",
          addedAt: alert.receivedAt,
          signalBarTs: levels.reversalBarTs,
          emailSubject: alert.subject,
          source: "u1_daily",
        };
        await upsert(TABLES.BULL_LIST, "pending", rowKey, row);
        activeTickers.add(alert.ticker);
        added.push(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push({ ticker: alert.ticker, reason: msg });
      }
    }

    return {
      jsonBody: {
        status: "ok",
        alertsFound: alerts.length,
        pendingAdded: added.length,
        skipped: skipped.length,
        details: { added, skipped },
      },
    };
  } catch (err) {
    const e = err as { message?: string; code?: string; response?: string; responseStatus?: string; authenticationFailed?: boolean };
    const detail = {
      message: e?.message ?? String(err),
      code: e?.code,
      response: e?.response,
      responseStatus: e?.responseStatus,
      authenticationFailed: e?.authenticationFailed,
    };
    ctx.error(`bullEmailTimer error: ${JSON.stringify(detail)}`);
    return { status: 500, jsonBody: { error: detail } };
  }
}

app.http("bullEmailTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "bull-email-timer",
  handler: bullEmailHandler,
});
