import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

/**
 * GET /api/uoa-signals                 — the latest end-of-day scan
 * GET /api/uoa-signals?date=YYYY-MM-DD — a specific day's scan
 * GET /api/uoa-signals?list=1          — available scan dates (newest first)
 * GET /api/uoa-signals?live=1          — the intraday burst feed, updated every 2 min
 *
 * A thin read proxy over the `uoa-signals` container so the storage key never
 * reaches the browser. Everything here is written by the cron Function App
 * (tools/cron-functions/src/uoa/), which does the Tradier work: SWA cuts a
 * managed API request off at 45 seconds and both the end-of-day sweep and the
 * pre-open watch-set build take minutes.
 *
 * Two different clocks, so two different caches. The daily scan changes once a
 * session and can sit for a minute. The live feed is the whole point of the
 * intraday view and must not be served stale — the tab polls it every 30
 * seconds and a 60-second cache would show the operator a burst that had
 * already been superseded.
 */

const CONTAINER = process.env.UOA_SIGNALS_CONTAINER || "uoa-signals";
const CACHE_MS = 60_000;
/** Well under the two-minute poll, so the tab never waits on our own cache. */
const LIVE_CACHE_MS = 10_000;

let container: ContainerClient | null = null;
const cache = new Map<string, { at: number; body: unknown }>();

function getContainer(): ContainerClient {
  if (!container) {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING not configured");
    container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  }
  return container;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { statusCode?: number }).statusCode === 404
  );
}

async function readJsonBlob(name: string): Promise<unknown | null> {
  try {
    const buf = await getContainer().getBlobClient(name).downloadToBuffer();
    return JSON.parse(buf.toString("utf-8"));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function listDates(): Promise<string[]> {
  const dates: string[] = [];
  try {
    for await (const blob of getContainer().listBlobsFlat()) {
      const m = blob.name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) dates.push(m[1]);
    }
  } catch (err) {
    if (isNotFound(err)) return []; // container not created yet — the scanner makes it on first write
    throw err;
  }
  return dates.sort().reverse();
}

async function uoaSignalsHandler(req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const wantList = req.query.get("list");
    const wantLive = req.query.get("live");
    const date = (req.query.get("date") || "").trim();
    const key = wantLive ? "live" : wantList ? "list" : date || "latest";
    const ttl = wantLive ? LIVE_CACHE_MS : CACHE_MS;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      return { headers: { "Cache-Control": "no-store" }, jsonBody: hit.body as object };
    }

    let body: unknown;
    if (wantLive) {
      body = await readJsonBlob("live.json");
      if (!body) {
        // Before the first poll of the day there is genuinely nothing, which is
        // not the same as an error. The tab says so rather than showing a
        // failure the operator would go looking for.
        return { status: 404, jsonBody: { error: "no_live_data" } };
      }
    } else if (wantList) {
      body = { dates: await listDates() };
    } else {
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { status: 400, jsonBody: { error: "date must be YYYY-MM-DD" } };
      }
      body = await readJsonBlob(date ? `${date}.json` : "latest.json");
      if (!body) {
        return {
          status: 404,
          jsonBody: { error: "no_scan_data", detail: date || "latest" },
        };
      }
    }

    cache.set(key, { at: Date.now(), body });
    return { headers: { "Cache-Control": "no-store" }, jsonBody: body as object };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("uoaSignals", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "uoa-signals",
  handler: uoaSignalsHandler,
});
