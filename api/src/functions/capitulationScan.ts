import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { runCapitulationScan } from "../lib/capitulationEngine.js";

async function capitulationScanHandler(_req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const result = await runCapitulationScan();
    return { jsonBody: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("capitulationScan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "capitulation-scan",
  handler: capitulationScanHandler,
});
