import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { runWeeklyCapitulationScan } from "../lib/weeklyCapitulationEngine.js";
import { isPushoverConfigured, sendWeeklyCapitulationAlerts } from "../lib/pushover.js";

function getETTime(): Date {
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etString);
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

type Phase = "morning" | "extended" | null;

function getPhase(et: Date): Phase {
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  if (totalMinutes >= 570 && totalMinutes < 600) return "morning";
  if (totalMinutes >= 600 && totalMinutes < 960) {
    if (minutes % 30 === 0) return "extended";
    return null;
  }
  return null;
}

async function weeklyCapitulationTimerHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  const expected = process.env.TIMER_SECRET;
  if (!expected || secret !== expected) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const et = getETTime();
  if (!isWeekday(et)) {
    return { jsonBody: { status: "skipped", reason: "weekend" } };
  }

  const phase = getPhase(et);
  if (!phase) {
    return { jsonBody: { status: "skipped", reason: "outside scan window" } };
  }

  if (!isPushoverConfigured()) {
    return { jsonBody: { status: "skipped", reason: "Pushover not configured" } };
  }

  ctx.log(`Weekly capitulation timer: phase=${phase}, ET=${et.toISOString()}`);

  try {
    const scanResult = await runWeeklyCapitulationScan();
    ctx.log(`Weekly cap scan: ${scanResult.signals.length} signals from ${scanResult.totalScanned} tickers`);

    const alertResults = await sendWeeklyCapitulationAlerts(scanResult.signals, phase);
    const sent = alertResults.filter((r) => r.success).length;
    const failed = alertResults.filter((r) => !r.success).length;

    ctx.log(`Weekly cap alerts: ${sent} sent, ${failed} failed`);

    return {
      jsonBody: {
        status: "ok",
        phase,
        signalsFound: scanResult.signals.length,
        alertsSent: sent,
        alertsFailed: failed,
        alerts: alertResults,
        scannedAt: scanResult.scannedAt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`Weekly capitulation timer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("weeklyCapitulationTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "weekly-capitulation-timer",
  handler: weeklyCapitulationTimerHandler,
});
