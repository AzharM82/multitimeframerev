import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { fetchBullAlerts } from "../lib/imap.js";
import { fetchDailyBarsExtended } from "../lib/polygon.js";
import { computeLevels } from "../lib/levels.js";
import { upsert, getOne, TABLES } from "../lib/tables.js";

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
  source: string;
  emailSubject: string;
  reversalBarTs: string;
}

function todayKey(): string {
  return new Date().toISOString().split("T")[0];
}

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
    const added: BullListRow[] = [];
    const skipped: { ticker: string; reason: string }[] = [];

    for (const alert of alerts) {
      const rowKey = `${date}_${alert.ticker}`;
      const existing = await getOne<BullListRow>(TABLES.BULL_LIST, "open", rowKey);
      if (existing) {
        skipped.push({ ticker: alert.ticker, reason: "already on list today" });
        continue;
      }

      try {
        const bars = await fetchDailyBarsExtended(alert.ticker, 2);
        const levels = computeLevels(alert.ticker, bars);
        if (!levels) {
          skipped.push({ ticker: alert.ticker, reason: "insufficient bars" });
          continue;
        }

        const row: BullListRow = {
          partitionKey: "open",
          rowKey,
          ticker: alert.ticker,
          entry: levels.entry,
          sl: levels.sl,
          tp: levels.tp,
          rPct: levels.rPct,
          status: "OPEN",
          addedAt: alert.receivedAt,
          source: levels.source,
          emailSubject: alert.subject,
          reversalBarTs: levels.reversalBarTs,
        };
        await upsert(TABLES.BULL_LIST, "open", rowKey, row);
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
        added: added.length,
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
