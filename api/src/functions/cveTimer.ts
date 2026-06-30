import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { runCve, persistSnapshot, type Phase } from "../lib/cveRun.js";
import { notify } from "../lib/cveNotify.js";

/**
 * POST /api/cve-timer?phase=open|close — run the Catalyst Value Eval, persist the
 * snapshot, and fire the email + Pushover notification. Triggered by the cron
 * Function App at T-5 min before open and T-10 min before close.
 *
 * Auth: x-timer-secret header must match TIMER_SECRET.
 */
async function cveTimerHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const phaseParam = (req.query.get("phase") ?? "manual").toLowerCase();
  const phase: Phase = phaseParam === "open" || phaseParam === "close" ? phaseParam : "manual";

  try {
    const snap = await runCve(phase);
    await persistSnapshot(snap);
    const sent = await notify(snap);
    ctx.log(
      `CVE ${phase}: scanned=${snap.scanned} pos=${snap.positives.length} neg=${snap.negatives.length} ` +
      `email=${sent.email} push=${sent.pushover}`,
    );
    return {
      jsonBody: {
        status: "ok",
        phase,
        asOf: snap.asOf,
        scanned: snap.scanned,
        discovered: snap.discovered,
        positives: snap.positives.map((r) => ({ ticker: r.ticker, grade: r.grade })),
        negatives: snap.negatives.map((r) => ({ ticker: r.ticker, grade: r.grade })),
        sources: snap.sources,
        notify: sent,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`cveTimer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("cveTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cve-timer",
  handler: cveTimerHandler,
});
