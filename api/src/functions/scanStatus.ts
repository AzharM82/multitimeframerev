import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { getStatus } from "../lib/scanStatus.js";

async function scanStatusHandler(_req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  return { jsonBody: getStatus() };
}

app.http("scanStatus", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "scan-status",
  handler: scanStatusHandler,
});
