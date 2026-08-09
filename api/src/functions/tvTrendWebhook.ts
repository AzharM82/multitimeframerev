import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { timingSafeEqual } from "node:crypto";
import { upsert, getOne, listByPartition, TABLES } from "../lib/tables.js";
import { enqueueWhatsApp } from "../lib/queue.js";
import { sendPushoverMessage } from "../lib/pushover.js";
import { readRegime, recommend, ageMinutes, REGIME_MAX_AGE_MIN } from "../lib/tvTrend/regime.js";

/**
 * POST /api/tv-trend-webhook   — TradingView alert sink (anonymous route)
 * GET  /api/tv-trend-webhook?date=YYYY-MM-DD  — audit log (portal role)
 *
 * Receives the "4-Chart Majority Trend Webhook Alerts" indicator: 4 breadth
 * symbols on 5-min Heikin-Ashi, 3-of-4 agreeing colour for 3 consecutive bars
 * starts a trend; it fires once on start and once on end, never in between.
 *
 * The streak is the TRIGGER. The Gate's SPY regime is the FILTER — see
 * lib/tvTrend/regime.ts for the combination rules.
 *
 * THREE CONSTRAINTS SHAPE THIS FILE:
 *
 *  1. TradingView cannot send custom headers. Every other machine endpoint here
 *     uses `x-timer-secret`; this one cannot, so the secret travels INSIDE the
 *     alert body (never the URL, which would land in logs). Source IP is
 *     recorded against TradingView's published ranges but is not enforced by
 *     default — see IP_ENFORCE below.
 *
 *  2. TradingView cancels a request that takes over 3 seconds. So: one point
 *     lookup for dedup, then every write and both alert channels fire in
 *     parallel, each with its own short timeout. Nothing here fans out.
 *
 *  3. Alerts may arrive twice. Events are keyed on (5-min bucket, trend, event)
 *     so a repeat is recorded as a duplicate and does NOT re-notify.
 */

/** TradingView's published webhook sources (verified against their docs). */
const TV_IPS = ["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"];

/**
 * IP is recorded always, enforced only on request.
 *
 * Deliberate default: if TradingView adds an egress IP, enforcing would silently
 * kill every signal, and a dead trading feed looks exactly like a quiet market.
 * The secret is the actual gate; the IP is evidence. Set TV_WEBHOOK_ENFORCE_IP=true
 * to make it a hard check.
 */
const IP_ENFORCE = process.env.TV_WEBHOOK_ENFORCE_IP === "true";

type Trend = "green" | "red";
type TrendEvent = "trend_start" | "trend_end";

interface Parsed {
  trend: Trend;
  event: TrendEvent;
  time: string | null;
  source: string | null;
  timeframe: string | null;
  secret: string | null;
  mode: "json" | "keyword";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function normTrend(v: unknown): Trend | null {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "green" || s === "bull" || s === "bullish") return "green";
  if (s === "red" || s === "bear" || s === "bearish") return "red";
  return null;
}

function normEvent(v: unknown): TrendEvent | null {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "trend_start" || s === "start" || s === "started") return "trend_start";
  if (s === "trend_end" || s === "end" || s === "ended") return "trend_end";
  return null;
}

/**
 * JSON first, keyword scan as fallback — the alert may be a JSON string or the
 * plain text of an `alert()` call.
 *
 * The fallback REFUSES ambiguity rather than guessing: a body mentioning both
 * colours, or neither, is rejected. Guessing here means recommending the wrong
 * side of the market. Which path was taken is recorded, so a fallback that
 * starts firing is visible instead of silently becoming the norm.
 */
export function parseAlert(raw: string): { ok: true; value: Parsed } | { ok: false; reason: string } {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o && typeof o === "object") {
      const trend = normTrend(o.trend);
      const event = normEvent(o.event);
      if (trend && event) {
        return {
          ok: true,
          value: {
            trend,
            event,
            time: str(o.time),
            source: str(o.source),
            timeframe: str(o.timeframe),
            secret: str(o.secret) ?? str(o.key),
            mode: "json",
          },
        };
      }
    }
  } catch {
    /* fall through to the keyword scan */
  }

  const t = raw.toLowerCase();
  const green = /\bgreen\b/.test(t);
  const red = /\bred\b/.test(t);
  // `_` is a word character, so \bend\b does NOT match inside "trend_end".
  const start = /\bstart(ed|s)?\b/.test(t) || t.includes("trend_start");
  const end = /\bend(ed|s)?\b/.test(t) || t.includes("trend_end");

  if (green === red) return { ok: false, reason: green ? "ambiguous colour: both green and red" : "no colour found" };
  if (start === end) return { ok: false, reason: start ? "ambiguous event: both start and end" : "no event found" };

  return {
    ok: true,
    value: {
      trend: green ? "green" : "red",
      event: start ? "trend_start" : "trend_end",
      time: null,
      source: null,
      timeframe: null,
      secret: raw.match(/secret["'\s]*[=:]["'\s]*([A-Za-z0-9_\-]{8,})/i)?.[1] ?? null,
      mode: "keyword",
    },
  };
}

function secretOk(given: string | null): boolean {
  const expected = process.env.TV_WEBHOOK_SECRET || "";
  if (!expected || !given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function clientIp(req: HttpRequest): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim() ?? "";
  // Azure appends :port on IPv4. Strip only when it is unambiguously that.
  const m = first.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : first;
}

/** ET wall-clock pieces, used for the partition, RTH test and display. */
function etNow(d = new Date()) {
  const date = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
  const label = d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const rth = dow >= 1 && dow <= 5 && time >= "09:30:00" && time < "16:00:00";
  return { date, time, label, rth };
}

/**
 * 5-minute bucket used for dedup. Prefers the bar time TradingView sent; falls
 * back to arrival time when it is missing or unparseable (the keyword path never
 * has one).
 */
function bucket(timeStr: string | null, nowMs: number): string {
  const parsed = timeStr ? Date.parse(timeStr) : Number.NaN;
  const ms = Number.isFinite(parsed) ? parsed : nowMs;
  return new Date(Math.floor(ms / 300_000) * 300_000).toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

const EMOJI = { green: "🟢", red: "🔴" } as const;

async function receive(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const now = new Date();
  const nowIso = now.toISOString();
  const et = etNow(now);
  const ip = clientIp(req);
  const fromTv = TV_IPS.includes(ip);

  const raw = (await req.text()).slice(0, 4000);

  // Every hit is logged before any decision, so a rejected or malformed alert is
  // still auditable. Best-effort: logging must never fail the 200.
  const logHit = (decision: string, detail: Record<string, unknown> = {}) =>
    upsert(TABLES.TV_TREND, `hit-${et.date}`, `${nowIso}-${ip || "noip"}`, {
      receivedAt: nowIso,
      ip,
      fromTradingView: fromTv,
      decision,
      raw,
      ...detail,
    }).catch((e) => ctx.warn(`tv-trend: hit log failed: ${e instanceof Error ? e.message : e}`));

  if (IP_ENFORCE && !fromTv) {
    await logHit("rejected:ip");
    return { status: 403, jsonBody: { error: "Forbidden" } };
  }

  const parsed = parseAlert(raw);
  if (!parsed.ok) {
    await logHit("rejected:unparseable", { reason: parsed.reason });
    ctx.warn(`tv-trend: unparseable alert (${parsed.reason})`);
    return { status: 400, jsonBody: { error: "Could not read alert", reason: parsed.reason } };
  }

  const { trend, event, mode, time, timeframe } = parsed.value;

  if (!secretOk(parsed.value.secret)) {
    await logHit("rejected:secret", { trend, event, parseMode: mode });
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const key = `evt-${bucket(time, now.getTime())}-${trend}-${event}`;
  const seen = await getOne<{ receivedAt?: string }>(TABLES.TV_TREND, `evt-${et.date}`, key);
  if (seen) {
    await logHit("duplicate", { trend, event, parseMode: mode, key });
    return { status: 200, jsonBody: { status: "duplicate", trend, event, key } };
  }

  const regime = await readRegime();
  const stale = !regime || ageMinutes(regime.capturedAt, now.getTime()) > REGIME_MAX_AGE_MIN;
  const rec = recommend(trend, event, regime, stale);

  const verb = event === "trend_start" ? "STARTED" : "ENDED";
  const head = `${EMOJI[trend]} ${trend.toUpperCase()} trend ${verb} ${et.label} ET`;
  const body =
    `${head}\n` +
    `→ ${rec.action === "NONE" ? "no trade" : rec.action}\n` +
    `${rec.why}\n` +
    `Regime: ${regime ? `${regime.label} · Gate ${regime.decision}` : "unknown"}` +
    (stale && regime ? " (STALE)" : "") +
    (et.rth ? "" : "\n⚠️ outside regular trading hours");

  // Everything below is parallel and individually best-effort: TradingView gets
  // its 200 inside 3s even if a channel is slow. Failures are logged, never thrown.
  const [, , push, wa] = await Promise.all([
    upsert(TABLES.TV_TREND, `evt-${et.date}`, key, {
      receivedAt: nowIso,
      trend,
      event,
      parseMode: mode,
      tvTime: time ?? "",
      timeframe: timeframe ?? "",
      action: rec.action,
      why: rec.why,
      aligned: rec.aligned,
      regimeLabel: regime?.label ?? "",
      regimeDecision: regime?.decision ?? "",
      regimeStale: stale,
      withinRth: et.rth,
      ip,
    }).catch((e) => { ctx.error(`tv-trend: event write failed: ${e}`); }),
    logHit("accepted", { trend, event, parseMode: mode, action: rec.action, key }),
    sendPushoverMessage(head, body, rec.action === "NONE" ? 0 : 1, 1200),
    enqueueWhatsApp({
      to: process.env.WHATSAPP_RECEIVER || "",
      text: body,
      meta: { kind: "tv-trend", trend, event, action: rec.action },
    }).then(() => true).catch(() => false),
  ]);

  ctx.log(`tv-trend ${trend}/${event} → ${rec.action} (parse=${mode}, push=${push}, wa=${wa})`);

  return {
    status: 200,
    jsonBody: {
      status: "ok",
      trend,
      event,
      action: rec.action,
      aligned: rec.aligned,
      regime: regime?.label ?? null,
      regimeStale: stale,
      withinRth: et.rth,
      parseMode: mode,
      notified: { pushover: push, whatsapp: wa },
    },
  };
}

/** Audit read — protected by the `/api/*` portal-role catch-all. */
async function audit(req: HttpRequest): Promise<HttpResponseInit> {
  const date = (req.query.get("date") || "").match(/^\d{4}-\d{2}-\d{2}$/)
    ? req.query.get("date")!
    : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const which = req.query.get("kind") === "hits" ? `hit-${date}` : `evt-${date}`;
  const rows = await listByPartition<Record<string, unknown>>(TABLES.TV_TREND, which);
  rows.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  const regime = await readRegime();
  return {
    jsonBody: {
      date,
      kind: which.startsWith("hit") ? "hits" : "events",
      count: rows.length,
      regime,
      regimeAgeMin: regime ? Math.round(ageMinutes(regime.capturedAt)) : null,
      rows,
    },
    headers: { "Cache-Control": "no-store" },
  };
}

async function handler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    return req.method === "POST" ? await receive(req, ctx) : await audit(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`tv-trend-webhook error: ${message}`);
    // Still a 200 on POST: TradingView treats non-2xx as a failed webhook, and
    // the hit is already logged. Surfacing the error to TradingView helps nobody.
    return req.method === "POST"
      ? { status: 200, jsonBody: { status: "error", error: message } }
      : { status: 500, jsonBody: { error: message } };
  }
}

app.http("tvTrendWebhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "tv-trend-webhook",
  handler,
});
