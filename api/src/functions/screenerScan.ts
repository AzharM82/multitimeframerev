import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { runScreener, type ScreenerType } from "../lib/screeners.js";

async function screenerScanHandler(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const type = (req.query.get("type") ?? "qullamaggie") as ScreenerType;
    const force = req.query.get("refresh") === "true";

    const data = await runScreener(type, force);

    return {
      jsonBody: data,
      headers: { "Content-Type": "application/json" },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Screener scan error:", message);
    return {
      status: 500,
      jsonBody: { error: message },
    };
  }
}

app.http("screenerScan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "screeners",
  handler: screenerScanHandler,
});
