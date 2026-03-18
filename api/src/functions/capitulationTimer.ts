import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { runCapitulationScan } from "../lib/capitulationEngine.js";
import { isPushoverConfigured, sendCapitulationAlerts } from "../lib/pushover.js";

function getETTime(): Date {
  // Get current time in America/New_York
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

  // 9:30 = 570, 10:00 = 600, 16:00 = 960
  if (totalMinutes >= 570 && totalMinutes < 600) {
    return "morning";
  }
  if (totalMinutes >= 600 && totalMinutes < 960) {
    return "extended";
  }
  return null; // outside market hours
}

async function capitulationTimerHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  // Validate shared secret
  const secret = req.headers.get("x-timer-secret");
  const expected = process.env.TIMER_SECRET;
  if (!expected || secret !== expected) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  // Check market hours
  const et = getETTime();
  if (!isWeekday(et)) {
    return { jsonBody: { status: "skipped", reason: "weekend" } };
  }

  const phase = getPhase(et);
  if (!phase) {
    return { jsonBody: { status: "skipped", reason: "outside scan window" } };
  }

  // Check Pushover config
  if (!isPushoverConfigured()) {
    return { jsonBody: { status: "skipped", reason: "Pushover not configured" } };
  }

  ctx.log(`Capitulation timer: phase=${phase}, ET=${et.toISOString()}`);

  try {
    // Run scan
    const scanResult = await runCapitulationScan();
    ctx.log(`Scan complete: ${scanResult.signals.length} signals from ${scanResult.totalScanned} tickers`);

    // Send alerts
    const alertResults = await sendCapitulationAlerts(scanResult.signals, phase);
    const sent = alertResults.filter((r) => r.success && !r.error).length;
    const suppressed = alertResults.filter((r) => r.error?.includes("suppressed")).length;
    const failed = alertResults.filter((r) => !r.success).length;

    ctx.log(`Alerts: ${sent} sent, ${suppressed} suppressed (dedup), ${failed} failed`);

    return {
      jsonBody: {
        status: "ok",
        phase,
        signalsFound: scanResult.signals.length,
        alertsSent: sent,
        alertsSuppressed: suppressed,
        alertsFailed: failed,
        alerts: alertResults,
        scannedAt: scanResult.scannedAt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`Capitulation timer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("capitulationTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "capitulation-timer",
  handler: capitulationTimerHandler,
});
