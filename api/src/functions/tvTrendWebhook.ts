import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { timingSafeEqual } from "node:crypto";
import { upsert, getOne, listByPartition, TABLES } from "../lib/tables.js";
import { readRegime, ageMinutes, REGIME_MAX_AGE_MIN } from "../lib/tvTrend/regime.js";
import { readState, writeState, advance, heldFor } from "../lib/tvTrend/state.js";
import { decide, actionLine } from "../lib/tvTrend/decide.js";
import { notifyBoth } from "../lib/tvTrend/notify.js";

/**
 * POST /api/tv-trend-webhook          — TradingView alert sink (anonymous route)
 * POST /api/tv-trend-webhook?flat=1   — force the believed position back to FLAT
 *                                       (x-timer-secret; no alert body needed)
 * GET  /api/tv-trend-webhook          — audit log + current belief (portal role)
 *
 * Receives the "4-Chart Majority Trend Webhook Alerts" indicator: 4 breadth
 * symbols on 5-min Heikin-Ashi, 3-of-4 agreeing colour for 3 consecutive bars
 * starts a trend. TradingView sends all four raw events; what they MEAN is
 * decided here — see lib/tvTrend/decide.ts for the regime-dependent rules.
 *
 * THE MESSAGE STREAM IS POSITION CHANGES, NOT EVENTS. A green_end on a bullish
 * day changes nothing, so it stays silent. That is what collapses four noisy
 * alert types into decisions, and it makes repeated firing harmless for free.
 *
 * CONSTRAINTS:
 *  1. TradingView cannot send custom headers, so the secret rides INSIDE the
 *     alert body (never the URL, which would land in logs).
 *  2. TradingView cancels at 3 seconds. Point lookups only, everything else
 *     parallel, each channel individually timed out.
 *  3. Alerts can arrive twice — (5-min bucket, trend, event) dedups exact
 *     retries; the position machine handles repeats across bars.
 */

/** TradingView's published webhook sources (verified against their docs). */
const TV_IPS = ["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"];

/**
 * IP is recorded always, enforced only on request. If TradingView adds an
 * egress IP, enforcing would silently kill every signal — and a dead trading
 * feed looks exactly like a quiet market. The secret is the gate.
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
 * The fallback REFUSES ambiguity rather than guessing: a body naming both
 * colours, or neither, is rejected. Guessing here trades the wrong side of the
 * market. The path used is recorded, so a fallback that starts firing is
 * visible instead of quietly becoming the norm.
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
            trend, event,
            time: str(o.time), source: str(o.source), timeframe: str(o.timeframe),
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
      time: null, source: null, timeframe: null,
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
  const m = first.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : first;
}

/** ET wall-clock pieces, for the partition, the RTH test and display. */
function etNow(d = new Date()) {
  const date = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
  const label = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const rth = dow >= 1 && dow <= 5 && time >= "09:30:00" && time < "16:00:00";
  return { date, time, label, rth };
}

/** 5-minute bucket for dedup: TradingView's bar time when present, else arrival. */
function bucket(timeStr: string | null, nowMs: number): string {
  const parsed = timeStr ? Date.parse(timeStr) : Number.NaN;
  const ms = Number.isFinite(parsed) ? parsed : nowMs;
  return new Date(Math.floor(ms / 300_000) * 300_000).toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

const EMOJI = { green: "🟢", red: "🔴" } as const;

/**
 * Operator escape hatch: our position is a belief and can drift from reality.
 *
 * Accepts a signed-in portal session OR the timer secret. The session is allowed
 * so the SPY Streak tab can offer a button — the alternative is an operator
 * reaching for curl to correct state mid-session, which is exactly when they
 * will not. The browser never sees the secret.
 */
async function forceFlat(req: HttpRequest): Promise<HttpResponseInit> {
  const signedIn = !!req.headers.get("x-ms-client-principal");
  const secret = req.headers.get("x-timer-secret");
  const viaSecret = !!process.env.TIMER_SECRET && secret === process.env.TIMER_SECRET;
  if (!signedIn && !viaSecret) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }
  const prev = await readState();
  await writeState({
    position: "FLAT", since: "", entryRegime: "",
    lastEvent: "force-flat", updatedAt: new Date().toISOString(),
  });
  return { jsonBody: { status: "ok", was: prev.position, now: "FLAT" } };
}

async function receive(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (req.query.get("flat") === "1") return forceFlat(req);

  const now = new Date();
  const nowIso = now.toISOString();
  const et = etNow(now);
  const ip = clientIp(req);
  const fromTv = TV_IPS.includes(ip);

  const raw = (await req.text()).slice(0, 4000);

  // Log every hit before any decision, so rejected and malformed alerts stay
  // auditable. Best-effort: logging must never fail the 200.
  const logHit = (decision: string, detail: Record<string, unknown> = {}) =>
    upsert(TABLES.TV_TREND, `hit-${et.date}`, `${nowIso}-${ip || "noip"}`, {
      receivedAt: nowIso, ip, fromTradingView: fromTv, decision, raw, ...detail,
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

  // Two point reads, together, to protect the 3s budget.
  const [regime, prevState] = await Promise.all([readRegime(), readState()]);
  const stale = !regime || ageMinutes(regime.capturedAt, now.getTime()) > REGIME_MAX_AGE_MIN;
  const usable = regime && !stale ? regime : null;

  const decision = decide({
    trend, event,
    position: prevState.position,
    direction: usable ? usable.direction : null,
    gate: usable ? usable.decision : null,
    regimeLabel: usable ? usable.label : regime ? `${regime.label} (STALE)` : "regime unknown",
  });

  const held = heldFor(prevState, now.getTime());
  const head =
    `${EMOJI[trend]} ${actionLine(decision.action)}` +
    (decision.notify ? ` · ${et.label} ET` : "");
  const body =
    `${head}\n` +
    `${decision.why}\n` +
    `${trend.toUpperCase()} ${event === "trend_start" ? "streak started" : "streak ended"}` +
    (held ? ` · ${held}` : "") + "\n" +
    `Regime: ${regime ? `${regime.label} · Gate ${regime.decision}` : "unknown"}${stale && regime ? " (STALE)" : ""}` +
    (et.rth ? "" : "\n⚠️ outside regular trading hours");

  const nextState = advance(
    prevState,
    decision.position,
    `${trend}:${event}`,
    usable?.label ?? "",
    nowIso,
  );

  const [, , notified] = await Promise.all([
    upsert(TABLES.TV_TREND, `evt-${et.date}`, key, {
      receivedAt: nowIso, trend, event, parseMode: mode,
      tvTime: time ?? "", timeframe: timeframe ?? "",
      action: decision.action, why: decision.why, notified: decision.notify,
      positionBefore: prevState.position, positionAfter: decision.position,
      regimeLabel: regime?.label ?? "", regimeDecision: regime?.decision ?? "", regimeStale: stale,
      withinRth: et.rth, ip,
    }).catch((e) => { ctx.error(`tv-trend: event write failed: ${e}`); }),
    logHit(decision.notify ? "accepted" : "accepted:silent", {
      trend, event, parseMode: mode, action: decision.action, key,
    }),
    decision.notify
      ? notifyBoth(head, body, "tv-trend", { trend, event, action: decision.action })
      : Promise.resolve({ pushover: false, whatsapp: false }),
  ]);

  // The state write is deliberately last: if it fails we would rather have
  // alerted on a correct decision than silently lose the alert.
  await writeState(nextState).catch((e) => ctx.error(`tv-trend: state write failed: ${e}`));

  ctx.log(`tv-trend ${trend}/${event} ${prevState.position}->${decision.position} ${decision.action} notify=${decision.notify}`);

  return {
    status: 200,
    jsonBody: {
      status: "ok", trend, event,
      action: decision.action,
      positionBefore: prevState.position,
      position: decision.position,
      why: decision.why,
      regime: regime?.label ?? null, regimeStale: stale,
      withinRth: et.rth, parseMode: mode,
      notified,
    },
  };
}

/**
 * Audit read — protected by the `/api/*` portal-role catch-all.
 *
 * One call returns everything the SPY Streak tab needs for a day: the live
 * banner (regime + position), the streak events, the regime samples that draw
 * the timeline, and the raw hits INCLUDING rejects. Rejects are deliberately in
 * the same payload — a wrong secret or a malformed alert must be visible on the
 * page, because from the operator's phone that is indistinguishable from a quiet
 * market. That confusion is exactly what prompted this tab.
 */
async function audit(req: HttpRequest): Promise<HttpResponseInit> {
  const q = (req.query.get("date") || "").match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.get("date")! : null;
  const date = q ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const [events, hits, regimeSamples, regime, state] = await Promise.all([
    listByPartition<Record<string, unknown>>(TABLES.TV_TREND, `evt-${date}`),
    listByPartition<Record<string, unknown>>(TABLES.TV_TREND, `hit-${date}`),
    listByPartition<Record<string, unknown>>(TABLES.TV_TREND, `rhist-${date}`),
    readRegime(),
    readState(),
  ]);
  const byTime = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.receivedAt ?? a.capturedAt).localeCompare(String(b.receivedAt ?? b.capturedAt));
  events.sort(byTime);
  hits.sort(byTime);
  regimeSamples.sort(byTime);

  /** Last time TradingView itself reached us — the real "is it alive" signal. */
  const lastFromTv = [...hits].reverse().find((h) => TV_IPS.includes(String(h.ip)));

  return {
    jsonBody: {
      date,
      position: state.position,
      positionSince: state.since,
      entryRegime: state.entryRegime,
      regime,
      regimeAgeMin: regime ? Math.round(ageMinutes(regime.capturedAt)) : null,
      lastTradingViewContact: lastFromTv?.receivedAt ?? null,
      events,
      hits,
      regimeSamples,
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
    // Still 200 on POST: TradingView treats non-2xx as a failed webhook, and
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
