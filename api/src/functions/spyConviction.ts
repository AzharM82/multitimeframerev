import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

/**
 * SPY Conviction moved to StockAgentHub on 2026-09-11 (operator decision). This
 * portal keeps ONLY the two webhook URLs TradingView may still be pointed at,
 * and relays each request, untouched, to the hub:
 *
 *   POST /api/spy-conviction     \  both forward body + query string verbatim
 *   POST /api/tv-trend-webhook   /   to SPY_FORWARD_URL (the hub's /api/spy-signal)
 *
 * The hub authenticates (same TV_WEBHOOK_SECRET, in the body or ?token=/?secret=),
 * dedupes, records, notifies, arms and trades; its status code and body are
 * returned as-is, so a wrong secret is still a 401 at TradingView.
 *
 * Why keep a relay at all: an alert pointed at a dead URL fails SILENTLY, which
 * from a phone looks exactly like a quiet market. Delete this file (and its two
 * anonymous entries in staticwebapp.config.json) once the TradingView alert URL
 * points at the hub directly.
 *
 * If the hub does not answer, TradingView gets a 200 with status
 * "forward-failed" rather than a 5xx: TradingView disables alerts that keep
 * erroring, and one slow hub start must not cost the rest of the session. The
 * relay waits up to 9 s — longer than TradingView's own 3 s — because the
 * function keeps running after TradingView hangs up, so a cold hub still
 * receives the alert.
 */

const FORWARD_TIMEOUT_MS = 9000;

async function relay(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const url = process.env.SPY_FORWARD_URL || "";
  if (!url) {
    ctx.error("spy relay: SPY_FORWARD_URL is not set");
    return { status: 200, jsonBody: { status: "forward-failed", reason: "relay not configured" } };
  }
  const body = await req.text();
  const qs = new URL(req.url).search; // carries ?token= / ?secret= when TradingView uses the URL form
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FORWARD_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": req.headers.get("content-type") || "text/plain",
        "x-forwarded-for": req.headers.get("x-forwarded-for") || "",
        // Marks the request as having come the old way. The hub records it, so
        // "is TradingView still pointed here?" has a definite answer — the
        // forwarded x-forwarded-for above makes a relayed hit otherwise
        // indistinguishable from a direct one.
        "x-relayed-by": "mtf-portal",
      },
      body,
      signal: ac.signal,
    });
    const text = await res.text();
    ctx.log(`spy relay → hub ${res.status}`);
    return { status: res.status, body: text, headers: { "Content-Type": res.headers.get("content-type") || "application/json" } };
  } catch (e) {
    ctx.error(`spy relay failed: ${e instanceof Error ? e.message : e}`);
    return { status: 200, jsonBody: { status: "forward-failed" } };
  } finally {
    clearTimeout(timer);
  }
}

app.http("spyConvictionRelay", { methods: ["POST"], authLevel: "anonymous", route: "spy-conviction", handler: relay });
app.http("spyConvictionLegacyRelay", { methods: ["POST"], authLevel: "anonymous", route: "tv-trend-webhook", handler: relay });
