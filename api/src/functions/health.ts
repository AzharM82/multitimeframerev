import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

async function health(_req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  return {
    jsonBody: {
      status: "ok",
      timestamp: new Date().toISOString(),
      polygonConfigured: !!process.env.POLYGON_API_KEY,
      storageConfigured: !!process.env.AZURE_STORAGE_CONNECTION_STRING,
      redisConfigured: !!process.env.REDIS_CONNECTION_STRING,
    },
  };
}

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: health,
});
