import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { timingSafeEqual } from "node:crypto";
import { upsert, getOne, listByPartition, TABLES } from "../lib/tables.js";
import {
  parseConviction, dedupeKey, formatAlert, barHHMM, barToEt,
  NOTIFY_ACTIONS, type ConvictionAlert,
} from "../lib/spyConviction/models.js";
import { readState, writeState, applySignal, advance, heldFor } from "../lib/spyConviction/state.js";
import { notifyBoth } from "../lib/notifyBoth.js";

/**
 * SPY Conviction Score — TradingView alert sink.
 *
 *   POST /api/spy-conviction            alert sink
 *   POST /api/tv-trend-webhook          the same sink, under the URL already
 *                                       pasted into TradingView (see below)
 *   POST …?flat=1                       force the believed position back to FLAT
 *   POST …?report=1                     store the EOD research report
 *   GET  …                              audit + state, for the portal tab
 *
 * Replaces the 5-min breadth-streak/Gate-regime system. Six legs (Cum TICK,
 * volume pressure, SPY vs VWAP, SPY vs EMA9, SPY/RSP lead, VIX) collapse into
 * one score on closed 10-minute SPY bars, and the indicator emits the decision
 * directly — there is no regime lookup here, which is also why this fits inside
 * TradingView's 3-second budget with room to spare.
 *
 * BOTH ROUTES ARE LIVE ON PURPOSE. `tv-trend-webhook` is the URL and secret
 * already configured in TradingView; retiring it would mean re-pasting every
 * alert, and an alert pointing at a dead URL fails silently — which from the
 * operator's phone is indistinguishable from a quiet market. New alerts should
 * use `/api/spy-conviction`; the old path stays as a permanent alias.
 *
 * NON-GOALS, deliberately: no broker, no orders placed or simulated, no
 * position sizing, no risk maths. Receive, authenticate, validate, record,
 * notify. Nothing else.
 */

/** TradingView's published webhook sources (verified against their docs). */
const TV_IPS = ["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"];

/**
 * IP is recorded always, enforced only on request. If TradingView adds an egress
 * IP, enforcing would silently kill every signal. The secret is the gate.
 */
const IP_ENFORCE = process.env.TV_WEBHOOK_ENFORCE_IP === "true";

function constantTimeEq(given: string, expected: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The secret may ride in the alert body (preferred) or the query string.
 *
 * Body is preferred because a URL lands in logs; the indicator emits a `secret`
 * field for exactly this. The query form is accepted because TradingView cannot
 * send custom headers and an alert whose message is a fixed indicator payload
 * may have nowhere else to put it — an unauthenticated fallback would be the
 * only worse option.
 */
interface AuthResult {
  ok: boolean;
  /** Which channel carried a credential — recorded on every hit. */
  via: "query" | "body" | "none";
  /**
   * LENGTH of what was presented, never the value.
   *
   * A rejected hit is otherwise a dead end: the body is redacted before it is
   * stored, so nothing distinguishes "a stale alert is still sending the
   * PASTE_SECRET_HERE placeholder" from "the secret was rotated and this one is
   * genuinely out of date". The length separates them instantly — 17 vs 48 — and
   * leaks nothing. Four hours of 401s on 2026-08-12 were diagnosed by reading
   * exactly this off TradingView's side, because our own log could not say.
   */
  presentedLen: number;
  expectedLen: number;
}

function authorized(req: HttpRequest, raw: string): AuthResult {
  const expected = process.env.TV_WEBHOOK_SECRET || "";
  const token = req.query.get("token") || req.query.get("secret") || "";
  const inBody = raw.match(/"(?:secret|key)"\s*:\s*"([^"]{8,200})"/)?.[1] ?? "";

  const via: AuthResult["via"] = token ? "query" : inBody ? "body" : "none";
  const presented = token || inBody;
  const base = { via, presentedLen: presented.length, expectedLen: expected.length };

  if (!expected) return { ok: false, ...base };
  if (token && constantTimeEq(token, expected)) return { ok: true, ...base, via: "query" };
  if (inBody && constantTimeEq(inBody, expected)) return { ok: true, ...base, via: "body" };
  return { ok: false, ...base };
}

function clientIp(req: HttpRequest): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim() ?? "";
  const m = first.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : first;
}

/** ET wall-clock pieces, for the storage partition and display. */
function etNow(d = new Date()) {
  const date = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
  const label = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return { date, time, label };
}

/**
 * Was the BAR inside regular hours — not, was the request.
 *
 * Judging by arrival marks a retried, backfilled or replayed alert as
 * out-of-hours even though the bar it describes sat squarely mid-session, and
 * the research agent then reports phantom overnight signals. Caught by that
 * agent's own mechanics review on the first conviction run, 2026-08-12.
 *
 * The timezone question lives in barToEt(), which decides from the stamp's own
 * markers rather than assuming — see the note there; it is the one field whose
 * misreading is completely silent.
 *
 * Falls back to arrival only when there is no usable bar stamp — an unknown bar
 * time is the one case where the request is the best evidence available.
 */
function barWithinRth(barTime: string, arrival: Date): boolean {
  const bar = barToEt(barTime);
  if (!bar || bar.dow < 0) {
    const t = arrival.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
    const d = arrival.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dow0 = new Date(`${d}T12:00:00Z`).getUTCDay();
    return dow0 >= 1 && dow0 <= 5 && t >= "09:30:00" && t < "16:00:00";
  }
  return bar.dow >= 1 && bar.dow <= 5 && bar.minutes >= 9 * 60 + 30 && bar.minutes < 16 * 60;
}

/** Table row keys reject `/ \ # ?`; the dedupe key uses none of them, but a
 *  malformed strategy name could. Sanitise rather than trust. */
const safeRowKey = (s: string) => s.replace(/[\\/#?]/g, "_").slice(0, 250);

/**
 * Strip the shared secret out of a body before it is stored or logged.
 *
 * The raw body is kept for the audit trail, and TradingView cannot send custom
 * headers — so the secret travels INSIDE that body. Storing it verbatim puts a
 * live credential in Table Storage on every single hit, and the audit endpoint
 * then serves it to anything that can read the tab. Redact at the boundary, so
 * there is no path by which the raw text is persisted with the secret intact.
 *
 * Deliberately pattern-based rather than "remove the known secret": a body
 * carrying a WRONG secret is exactly the case worth logging, and printing a
 * failed guess is nearly as bad as printing the real one.
 */
function redactSecrets(raw: string): string {
  return raw
    .replace(/("(?:secret|key|token)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/\b((?:secret|key|token)\s*[=:]\s*"?)[A-Za-z0-9_\-]{8,}("?)/gi, "$1[redacted]$2");
}

const SIDE_EMOJI: Record<string, string> = { CALL: "🟢", PUT: "🔴", NONE: "⚪" };

/** The Pushover/WhatsApp body: the one-liner, then why, then the six legs. */
function messageBody(a: ConvictionAlert, held: string | null, et: ReturnType<typeof etNow>, rth: boolean): string {
  const lines = [formatAlert(a)];

  const grade = [a.grade, a.bias].filter(Boolean).join(" · ");
  if (grade) lines.push(grade);

  const ctx: string[] = [];
  if (a.vwap !== null) ctx.push(`VWAP ${a.vwap}`);
  if (a.ema9 !== null) ctx.push(`EMA9 ${a.ema9}`);
  if (a.atr !== null) ctx.push(`ATR ${a.atr}`);
  if (a.extAtr !== null) ctx.push(`ext ${a.extAtr} ATR`);
  if (ctx.length) lines.push(ctx.join(" · "));

  const legs: string[] = [];
  if (a.tick !== null) legs.push(`TICK ${a.tick}`);
  if (a.cvd !== null) legs.push(`CVD ${a.cvd}`);
  if (a.breadthRatio !== null) legs.push(`breadth ${a.breadthRatio}`);
  if (a.vix !== null) legs.push(`VIX ${a.vix}`);
  if (legs.length) lines.push(legs.join(" · "));

  if (a.barsHeld !== null && a.barsHeld > 0) lines.push(`${a.barsHeld} bars in trade`);
  if (held) lines.push(held);
  lines.push(`${et.label} ET`);
  if (!rth) lines.push("⚠️ bar is outside regular trading hours");
  return lines.join("\n");
}

// ── operator escape hatches ─────────────────────────────────────────────────

/**
 * Our position is a belief and can drift from reality — the operator places
 * every trade by hand and may skip one.
 *
 * Accepts a signed-in portal session OR the timer secret, so the tab can offer a
 * button. The alternative is an operator reaching for curl to correct state
 * mid-session, which is exactly when they will not.
 */
async function forceFlat(req: HttpRequest): Promise<HttpResponseInit> {
  const signedIn = !!req.headers.get("x-ms-client-principal");
  const viaSecret = !!process.env.TIMER_SECRET && req.headers.get("x-timer-secret") === process.env.TIMER_SECRET;
  if (!signedIn && !viaSecret) return { status: 401, jsonBody: { error: "Unauthorized" } };

  const prev = await readState();
  await writeState({
    ...prev,
    state: "FLAT", since: "", entryScore: 0, entryPx: 0,
    lastSignal: "force-flat", updatedAt: new Date().toISOString(),
  });
  return { jsonBody: { status: "ok", was: prev.state, now: "FLAT" } };
}

/**
 * Store the EOD research report, written by tools/streak-research running
 * locally so the Claude CLI works against the existing subscription rather than
 * a model key in Azure. Timer secret only: a machine writer, never a browser.
 */
async function saveReport(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }
  const body = (await req.json().catch(() => null)) as { date?: string; report?: unknown } | null;
  const date = String(body?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !body?.report) {
    return { status: 400, jsonBody: { error: "date (YYYY-MM-DD) and report required" } };
  }
  await upsert(TABLES.SPY_CONVICTION, "report", date, {
    payloadJson: JSON.stringify(body.report).slice(0, 60_000),
    generatedAt: new Date().toISOString(),
  });
  return { jsonBody: { status: "ok", date } };
}

// ── the sink ────────────────────────────────────────────────────────────────

async function receive(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (req.query.get("flat") === "1") return forceFlat(req);
  if (req.query.get("report") === "1") return saveReport(req);

  const now = new Date();
  const nowIso = now.toISOString();
  const et = etNow(now);
  const ip = clientIp(req);
  const fromTv = TV_IPS.includes(ip);
  const raw = (await req.text()).slice(0, 8000);

  /**
   * Log every hit before any decision, so rejected and malformed alerts stay
   * auditable and land on the tab. A wrong secret is indistinguishable from a
   * quiet market unless it is visible somewhere — that confusion is what
   * prompted the tab in the first place. Best-effort: logging never fails the 200.
   */
  const logHit = (decision: string, detail: Record<string, unknown> = {}) =>
    upsert(TABLES.SPY_CONVICTION, `hit-${et.date}`, `${nowIso}-${ip || "noip"}`, {
      receivedAt: nowIso, ip, fromTradingView: fromTv, decision,
      raw: redactSecrets(raw).slice(0, 4000), ...detail,
    }).catch((e) => ctx.warn(`spy-conviction: hit log failed: ${e instanceof Error ? e.message : e}`));

  if (IP_ENFORCE && !fromTv) {
    await logHit("rejected:ip");
    return { status: 403, jsonBody: { error: "Forbidden" } };
  }

  /**
   * A bad secret is 401 and is NOT dead-lettered: that is not TradingView
   * getting it wrong, it is someone else knocking, and it should stay loud.
   */
  const auth = authorized(req, raw);
  if (!auth.ok) {
    await logHit("rejected:secret", {
      secretVia: auth.via, secretLen: auth.presentedLen, expectedLen: auth.expectedLen,
    });
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const parsed = parseConviction(raw);
  if (!parsed.ok) {
    /**
     * 200, not 4xx. TradingView disables an alert that keeps erroring, so a
     * strict rejection would silence the feed for the rest of the session over
     * one malformed message. The body is already in the hit log above, tagged,
     * where it can be read without losing the alert.
     */
    await logHit("deadletter", { reason: parsed.reason });
    ctx.error(`spy-conviction: deadletter — ${parsed.reason}`);
    return { status: 200, jsonBody: { status: "deadletter", reason: parsed.reason } };
  }

  const alert = parsed.alert;
  const key = safeRowKey(dedupeKey(alert));

  // TradingView retries; a retry must not notify twice.
  const seen = await getOne<{ receivedAt?: string }>(TABLES.SPY_CONVICTION, `evt-${et.date}`, key);
  if (seen) {
    await logHit("duplicate", { signal: alert.signal, key });
    return { status: 200, jsonBody: { status: "duplicate", signal: alert.signal, key } };
  }

  const prev = await readState();
  const transition = applySignal(prev.state, alert.signal);
  if (transition.anomaly) {
    ctx.warn(`spy-conviction: anomaly — ${transition.detail}`);
  }

  const line = formatAlert(alert);
  const head = `${SIDE_EMOJI[alert.side] ?? "⚪"} ${alert.signal}` +
    (alert.score !== null ? ` · score ${alert.score}` : "");
  const withinRth = barWithinRth(alert.barTime, now);
  const body = messageBody(alert, heldFor(prev, now.getTime()), et, withinRth);

  const shouldNotify = NOTIFY_ACTIONS.has(alert.action);

  const [, , notified] = await Promise.all([
    upsert(TABLES.SPY_CONVICTION, `evt-${et.date}`, key, {
      receivedAt: nowIso,
      strategy: alert.strategy,
      signal: alert.signal, action: alert.action, side: alert.side,
      grade: alert.grade ?? "", bias: alert.bias ?? "",
      score: alert.score ?? 0, legsAgree: alert.legsAgree ?? 0,
      entryTrigger: alert.entryTrigger ?? "", entryDistAtr: alert.entryDistAtr ?? 0,
      extAtr: alert.extAtr ?? 0, barsHeld: alert.barsHeld ?? 0,
      entryScore: alert.entryScore ?? 0, entryPx: alert.entryPx ?? 0,
      blockReason: alert.blockReason ?? "",
      spy: alert.spy ?? 0, vwap: alert.vwap ?? 0, ema9: alert.ema9 ?? 0,
      atr: alert.atr ?? 0, vix: alert.vix ?? 0, tick: alert.tick ?? 0,
      cvd: alert.cvd ?? 0, breadthRatio: alert.breadthRatio ?? 0,
      tf: alert.tf ?? "", chartSymbol: alert.chartSymbol ?? "",
      barTime: alert.barTime, barHhmm: barHHMM(alert.barTime),
      stateFrom: transition.from, stateTo: transition.to,
      anomaly: transition.anomaly, anomalyDetail: transition.detail,
      notified: shouldNotify, withinRth, ip, line,
    }).catch((e) => { ctx.error(`spy-conviction: event write failed: ${e}`); }),
    logHit(transition.anomaly ? "accepted:anomaly" : shouldNotify ? "accepted" : "accepted:silent",
      { signal: alert.signal, action: alert.action, key, secretVia: auth.via }),
    shouldNotify
      ? notifyBoth(head, body, "spy-conviction", {
          signal: alert.signal, action: alert.action, side: alert.side, score: alert.score,
        })
      : Promise.resolve({ pushover: false, whatsapp: false }),
  ]);

  // The state write is last: if it fails we would rather have alerted on a
  // correct decision than silently lost the alert.
  await writeState(advance(prev, transition, alert.signal, alert.barTime, alert.score, alert.spy, nowIso))
    .catch((e) => ctx.error(`spy-conviction: state write failed: ${e}`));

  ctx.log(`spy-conviction ${alert.signal} ${transition.from}->${transition.to} notify=${shouldNotify}`);

  return {
    status: 200,
    jsonBody: {
      status: "ok",
      signal: alert.signal,
      action: alert.action,
      state: transition.to,
      stateFrom: transition.from,
      anomaly: transition.anomaly,
      notified: shouldNotify ? notified : false,
      withinRth,
      line,
    },
  };
}

// ── audit read ──────────────────────────────────────────────────────────────

/**
 * One call returns everything the Conviction tab needs for a day: the live
 * banner, every alert, and the raw hits INCLUDING rejects and dead letters.
 * Rejects are in the same payload deliberately — a wrong secret must be visible
 * on the page, not only in a log nobody opens.
 */
async function audit(req: HttpRequest): Promise<HttpResponseInit> {
  /**
   * A signed-in portal session, or the local research job. Without the second
   * case the EOD agent cannot read its own input — the trap that broke the
   * journal summariser, closed here up front rather than rediscovered.
   */
  const signedIn = !!req.headers.get("x-ms-client-principal");
  const viaSecret = !!process.env.TIMER_SECRET && req.headers.get("x-timer-secret") === process.env.TIMER_SECRET;
  if (!signedIn && !viaSecret) return { status: 401, jsonBody: { error: "Unauthorized" } };

  const q = (req.query.get("date") || "").match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.get("date")! : null;
  const date = q ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const [events, hits, state, reportRow] = await Promise.all([
    listByPartition<Record<string, unknown>>(TABLES.SPY_CONVICTION, `evt-${date}`),
    listByPartition<Record<string, unknown>>(TABLES.SPY_CONVICTION, `hit-${date}`),
    readState(),
    getOne<{ payloadJson?: string }>(TABLES.SPY_CONVICTION, "report", date),
  ]);

  let research: unknown = null;
  if (reportRow?.payloadJson) {
    try { research = JSON.parse(reportRow.payloadJson); } catch { research = null; }
  }

  const byTime = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? ""));
  events.sort(byTime);
  hits.sort(byTime);

  /** Last time TradingView itself reached us — the real "is it alive" signal. */
  const lastFromTv = [...hits].reverse().find((h) => TV_IPS.includes(String(h.ip)));

  return {
    jsonBody: {
      date,
      state: state.state,
      since: state.since,
      entryScore: state.entryScore,
      entryPx: state.entryPx,
      lastSignal: state.lastSignal,
      lastBarTime: state.lastBarTime,
      anomalies: state.anomalies,
      lastTradingViewContact: lastFromTv?.receivedAt ?? null,
      events,
      hits,
      research,
    },
    headers: { "Cache-Control": "no-store" },
  };
}

async function handler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    return req.method === "POST" ? await receive(req, ctx) : await audit(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`spy-conviction error: ${message}`);
    // Still 200 on POST: TradingView treats non-2xx as a failed webhook and will
    // eventually disable the alert. The hit is already logged.
    return req.method === "POST"
      ? { status: 200, jsonBody: { status: "error", error: message } }
      : { status: 500, jsonBody: { error: message } };
  }
}

app.http("spyConviction", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "spy-conviction",
  handler,
});

/**
 * The URL already pasted into TradingView. Kept as a permanent alias so the
 * cutover needs no change on the TradingView side — see the note at the top.
 */
app.http("spyConvictionLegacyRoute", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "tv-trend-webhook",
  handler,
});
