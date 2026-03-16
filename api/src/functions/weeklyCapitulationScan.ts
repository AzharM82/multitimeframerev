import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { runWeeklyCapitulationScan } from "../lib/weeklyCapitulationEngine.js";

async function weeklyCapitulationScanHandler(_req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const result = await runWeeklyCapitulationScan();
    return { jsonBody: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("weeklyCapitulationScan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "weekly-capitulation-scan",
  handler: weeklyCapitulationScanHandler,
});
