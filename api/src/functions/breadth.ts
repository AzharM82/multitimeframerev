import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { fetchIndexBreadth, type BreadthStats } from "../lib/breadth.js";

// Two index gauges: large-cap (S&P 500) + growth/tech (Nasdaq 100).
const INDICES: { label: string; filter: string }[] = [
  { label: "S&P 500", filter: "idx_sp500" },
  { label: "Nasdaq 100", filter: "idx_ndx" },
];

interface BreadthPayload {
  generated: string;
  indices: BreadthStats[];
}

// Best-effort per-instance cache so repeated page loads don't re-hit Finviz.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: BreadthPayload } | null = null;

/** GET /api/breadth — market-health gauge for the configured indices. Computed
 *  live from Finviz Technical export (SMA-distance columns); cached ~10 min. */
async function breadthHandler(req: HttpRequest): Promise<HttpResponseInit> {
  try {
    const fresh = req.query.get("refresh") === "true";
    if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return { headers: { "Cache-Control": "no-store" }, jsonBody: cache.data };
    }
    const indices = await Promise.all(INDICES.map((i) => fetchIndexBreadth(i.label, i.filter)));
    const data: BreadthPayload = { generated: new Date().toISOString(), indices };
    cache = { at: Date.now(), data };
    return { headers: { "Cache-Control": "no-store" }, jsonBody: data };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("breadth", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "breadth",
  handler: breadthHandler,
});
