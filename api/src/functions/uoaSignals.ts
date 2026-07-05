import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

/**
 * GET /api/uoa-signals              — latest scan payload
 * GET /api/uoa-signals?date=YYYY-MM-DD — a specific day's scan
 * GET /api/uoa-signals?list=1      — available scan dates (newest first)
 *
 * The UOA scanner (github.com/AzharM82/UnusualOptions) runs as a GitHub Actions
 * cron and writes signal JSON into this storage account's `uoa-signals`
 * container — this endpoint is a thin read proxy so the storage key never
 * reaches the browser. Payloads change once per trading day; a short in-memory
 * cache absorbs tab-switch refetches.
 */

const CONTAINER = process.env.UOA_SIGNALS_CONTAINER || "uoa-signals";
const CACHE_MS = 60_000;

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

async function readJsonBlob(name: string): Promise<unknown | null> {
  try {
    const buf = await getContainer().getBlobClient(name).downloadToBuffer();
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

async function listDates(): Promise<string[]> {
  const dates: string[] = [];
  for await (const blob of getContainer().listBlobsFlat()) {
    const m = blob.name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m) dates.push(m[1]);
  }
  return dates.sort().reverse();
}

async function uoaSignalsHandler(req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const wantList = req.query.get("list");
    const date = (req.query.get("date") || "").trim();
    const key = wantList ? "list" : date || "latest";

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return { headers: { "Cache-Control": "no-store" }, jsonBody: hit.body as object };
    }

    let body: unknown;
    if (wantList) {
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
