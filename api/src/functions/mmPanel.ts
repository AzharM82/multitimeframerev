import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { getPanel, PANELS, type PanelName } from "../lib/mm/panelCache.js";

/**
 * GET /api/mm-panel?panel=key-metrics|breadth|industries|screeners|movers
 *
 * Read-only view of a Metrics panel from the cron-warmed cache.
 *
 * This NEVER computes on demand. Key Metrics alone issues dozens of paced
 * FinViz requests and takes minutes — far past the Static Web Apps function
 * timeout — so a cold cache returns 503 with a clear message rather than
 * hanging the browser. The same design as the original MarketMetrics app,
 * whose endpoints also served cache only.
 */

async function mmPanel(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const panel = req.query.get("panel") as PanelName | null;

    if (!panel) {
      return { status: 400, jsonBody: { error: "panel parameter required", panels: PANELS } };
    }
    if (!PANELS.includes(panel)) {
      return { status: 400, jsonBody: { error: `unknown panel '${panel}'`, panels: PANELS } };
    }

    const hit = await getPanel<unknown>(panel);
    if (!hit) {
      return {
        status: 503,
        jsonBody: {
          error: "no_panel_data",
          message: "This panel has not been computed yet — the refresh timer runs after the close.",
          panel,
        },
      };
    }

    return {
      jsonBody: { panel, generated: hit.generated, data: hit.data },
      headers: { "Cache-Control": "no-store" },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`mm-panel error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("mmPanel", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "mm-panel",
  handler: mmPanel,
});
