import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { putPanel, PANELS, type PanelName } from "../lib/mm/panelCache.js";
import { computeAllKeyMetrics } from "../lib/mm/keyMetrics.js";
import { computeBreadthData } from "../lib/mm/stockbee.js";
import { runScreener } from "../lib/mm/screeners.js";
import { computeMovers } from "../lib/mm/movers.js";

/**
 * POST /api/mm-timer?panel=<name>
 *
 * Recomputes one Metrics panel and writes it to the cache. Fired by
 * mtfrev-cron; guarded by the shared x-timer-secret like every other job here.
 *
 * ONE PANEL PER CALL, deliberately. The panels are paced sequentially to avoid
 * FinViz 429s — Key Metrics walks 5 index groups with ~2s gaps and can run for
 * minutes. Computing all five in a single invocation would blow the function
 * timeout, which is exactly why the original app split its refresh into 11
 * separate batches driven from outside the repo.
 *
 * Omitting ?panel runs them all in sequence — useful for a manual backfill, but
 * not what the cron should call.
 */

async function computePanel(panel: PanelName): Promise<unknown> {
  switch (panel) {
    case "key-metrics":
      return computeAllKeyMetrics();
    case "breadth":
      return computeBreadthData(60);
    case "screeners":
      return {
        qullamaggie: await runScreener("qullamaggie"),
        minervini: await runScreener("minervini"),
        oneil: await runScreener("oneil"),
      };
    case "movers":
      return {
        club97: await computeMovers("97club"),
        m9m: await computeMovers("9m_movers"),
        w20pct: await computeMovers("20pct_weekly"),
        d4pct: await computeMovers("4pct_daily"),
      };
  }
}

async function mmTimer(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const requested = req.query.get("panel") as PanelName | null;
  if (requested && !PANELS.includes(requested)) {
    return { status: 400, jsonBody: { error: `unknown panel '${requested}'`, panels: PANELS } };
  }

  const targets: PanelName[] = requested ? [requested] : PANELS;
  const refreshed: Record<string, string> = {};

  for (const panel of targets) {
    const started = Date.now();
    try {
      const data = await computePanel(panel);
      await putPanel(panel, data);
      refreshed[panel] = `ok in ${Math.round((Date.now() - started) / 1000)}s`;
      ctx.log(`mm-timer: ${panel} refreshed in ${Date.now() - started}ms`);
    } catch (err) {
      // One failing panel must not prevent the others from refreshing, and the
      // previously cached copy is left intact rather than being overwritten
      // with a partial or empty result.
      const message = err instanceof Error ? err.message : "Unknown error";
      refreshed[panel] = `FAILED: ${message}`;
      ctx.error(`mm-timer: ${panel} failed: ${message}`);
    }
  }

  const failed = Object.values(refreshed).filter((v) => v.startsWith("FAILED")).length;
  return {
    status: failed === targets.length ? 500 : 200,
    jsonBody: { status: failed ? "partial" : "ok", refreshed },
  };
}

app.http("mmTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "mm-timer",
  handler: mmTimer,
});
