import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { loadSnapshot } from "../lib/cveRun.js";

/** GET /api/cve-scan — returns the latest stored Catalyst Value Eval snapshot
 *  (top 3 bullish + top 3 bearish, B/A/A+ only, plus the full tradeable list).
 *  Populated twice daily by cve-timer (pre-open + pre-close). */
async function cveScanHandler(_req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const snap = await loadSnapshot();
    if (!snap) {
      return {
        status: 503,
        jsonBody: { error: "no_snapshot", message: "No CVE evaluation has run yet." },
      };
    }
    return { headers: { "Cache-Control": "no-store" }, jsonBody: snap };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("cveScan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cve-scan",
  handler: cveScanHandler,
});
