import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { optionsFeed } from "../lib/optionsChain.js";
import { tradierConfigured } from "../lib/tradier.js";

async function health(_req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  return {
    jsonBody: {
      status: "ok",
      timestamp: new Date().toISOString(),
      polygonConfigured: !!process.env.POLYGON_API_KEY,
      storageConfigured: !!process.env.AZURE_STORAGE_CONNECTION_STRING,
      redisConfigured: !!process.env.REDIS_CONNECTION_STRING,
      // Which option feed the DEPLOYED build is actually on, and whether its
      // credential arrived. The Options Guide itself is portal-gated, so
      // without this there is no way to confirm from outside that a deploy
      // landed on the feed it was meant to — which is exactly the check that
      // was missing when a stale build silently reverted a rule in September.
      optionsFeed: optionsFeed(),
      tradierConfigured: tradierConfigured(),
    },
  };
}

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: health,
});
