import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { readSectorDeskHistory } from "../lib/mm/sectorDeskHistory.js";

/**
 * GET /api/sector-desk-history?days=30
 *
 * Per-sector daily strength series for the Sector Desk oscillator. Reads the
 * `SectorDeskHistory` table (written by the sector-desk cron); returns each of
 * the 11 sectors with up to `days` daily points, ascending. Empty until the
 * cron has run for a few sessions.
 */

async function sectorDeskHistory(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const raw = Number(req.query.get("days"));
    const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.floor(raw))) : 30;
    const sectors = await readSectorDeskHistory(days);
    return {
      jsonBody: { days, sectors },
      headers: { "Cache-Control": "no-store" },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`sector-desk-history error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("sectorDeskHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sector-desk-history",
  handler: sectorDeskHistory,
});
