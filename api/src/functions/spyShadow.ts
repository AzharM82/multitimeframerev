import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { upsert, listByPartition, listAll, TABLES } from "../lib/tables.js";
import { RULE, simulate, summarize, sizeForAccount, type ShadowResult, type ShadowSignal, type LedgerRow } from "../lib/spyShadow/rule.js";
import { fetchSpyBars, fetchOptionBars } from "../lib/spyShadow/data.js";

/**
 * SPY Conviction shadow ledger.
 *
 *   POST /api/spy-shadow                  evaluate today's ET session (cron, 4:20 PM ET)
 *   POST /api/spy-shadow?date=YYYY-MM-DD  evaluate one past day (idempotent)
 *   POST /api/spy-shadow?from=…&to=…      backfill a range, weekdays only
 *   GET  /api/spy-shadow?date=YYYY-MM-DD  that day's rows + the whole ledger's summary
 *
 * The POST is guarded by the timer secret OR a signed-in portal session, so the
 * tab can offer a "re-evaluate" button. Re-running a day overwrites the same
 * rows (PK = ET day, RK = bar time + side), so it is safe to repeat.
 *
 * The rule itself lives in lib/spyShadow/rule.ts and is applied to accepted
 * BUY rows only — the rows whose state transition actually opened a position.
 * ARM, HOLD and anomalous BUYs are not trades under this rule.
 *
 * NOTHING HERE PLACES AN ORDER. It is a scoreboard for a rule the operator is
 * considering, written so the rule cannot drift between reviews.
 */

interface EventRow {
  rowKey: string;
  signal?: string;
  side?: string;
  stateTo?: string;
  withinRth?: boolean;
  barTime?: string;
  barHhmm?: string;
  spy?: number;
  score?: number;
  entryTrigger?: string;
}

interface ShadowRow extends ShadowResult {
  partitionKey: string;
  rowKey: string;
  day: string;
  side: "CALL" | "PUT";
  barTime: string;
  barHhmm: string;
  signalSpy: number;
  signalScore: number;
  entryTrigger: string;
  evaluatedAt: string;
  ruleLabel: string;
  backfilled: boolean;
}

const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

function authorized(req: HttpRequest): boolean {
  const signedIn = !!req.headers.get("x-ms-client-principal");
  const viaSecret = !!process.env.TIMER_SECRET && req.headers.get("x-timer-secret") === process.env.TIMER_SECRET;
  return signedIn || viaSecret;
}

/** Accepted BUYs for a day, oldest first. */
async function signalsFor(day: string): Promise<(ShadowSignal & { barHhmm: string; score: number; entryTrigger: string })[]> {
  const events = await listByPartition<EventRow>(TABLES.SPY_CONVICTION, `evt-${day}`);
  return events
    .filter((e) => (e.signal === "BUY_CALL" || e.signal === "BUY_PUT")
      && (e.stateTo === "LONG_CALL" || e.stateTo === "LONG_PUT")
      && e.withinRth !== false && typeof e.spy === "number" && !!e.barTime)
    .sort((a, b) => String(a.barTime).localeCompare(String(b.barTime)))
    .map((e) => ({
      day, side: e.signal === "BUY_CALL" ? "CALL" as const : "PUT" as const,
      barTime: e.barTime!, spy: e.spy!, barHhmm: e.barHhmm ?? e.barTime!.slice(11, 16),
      score: e.score ?? 0, entryTrigger: e.entryTrigger ?? "",
    }));
}

async function evaluateDay(day: string, backfilled: boolean, ctx: InvocationContext): Promise<{ day: string; signals: number; filled: number; noTouch: number; noData: number; netUsd: number }> {
  const sigs = await signalsFor(day);
  const out = { day, signals: sigs.length, filled: 0, noTouch: 0, noData: 0, netUsd: 0 };
  if (!sigs.length) return out;

  const [spy1, spy2] = await Promise.all([fetchSpyBars(day, "1Min"), fetchSpyBars(day, "2Min")]);
  const optCache = new Map<string, Promise<import("../lib/spyShadow/rule.js").MinuteBar[]>>();
  const now = new Date().toISOString();

  for (const s of sigs) {
    let result: ShadowResult;
    try {
      const contract = simulate(s, spy1, spy2, []).contract; // symbol only; no bars yet
      if (!optCache.has(contract)) optCache.set(contract, fetchOptionBars(contract, day));
      result = simulate(s, spy1, spy2, await optCache.get(contract)!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.warn(`spy-shadow ${day} ${s.barHhmm} ${s.side}: ${message}`);
      result = { ...simulate(s, [], [], []), note: message.slice(0, 200) };
    }
    const row: ShadowRow = {
      ...result,
      partitionKey: day, rowKey: `${s.barHhmm.replace(":", "")}|${s.side}`,
      day, side: s.side, barTime: s.barTime, barHhmm: s.barHhmm,
      signalSpy: s.spy, signalScore: s.score, entryTrigger: s.entryTrigger,
      evaluatedAt: now, ruleLabel: RULE.label, backfilled,
    };
    await upsert(TABLES.SPY_SHADOW, row.partitionKey, row.rowKey, row);
    if (result.status === "FILLED") { out.filled += 1; out.netUsd += result.netUsd ?? 0; }
    else if (result.status === "NO_TOUCH") out.noTouch += 1;
    else out.noData += 1;
  }
  out.netUsd = Math.round(out.netUsd * 100) / 100;
  ctx.log(`spy-shadow ${day}: ${JSON.stringify(out)}`);
  return out;
}

function* weekdays(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) yield d.toISOString().slice(0, 10);
  }
}

async function evaluate(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!authorized(req)) return { status: 401, jsonBody: { error: "Unauthorized" } };
  const from = req.query.get("from"); const to = req.query.get("to"); const date = req.query.get("date");
  const today = etToday();

  if (isDate(from) && isDate(to)) {
    if (from > to || to > today) return { status: 400, jsonBody: { error: "bad range" } };
    const days: Awaited<ReturnType<typeof evaluateDay>>[] = [];
    for (const day of weekdays(from, to)) days.push(await evaluateDay(day, day !== today, ctx));
    return { jsonBody: { status: "ok", rule: RULE.label, days } };
  }
  const day = isDate(date) ? date : today;
  if (day > today) return { status: 400, jsonBody: { error: "future date" } };
  return { jsonBody: { status: "ok", rule: RULE.label, ...(await evaluateDay(day, day !== today, ctx)) } };
}

async function read(req: HttpRequest): Promise<HttpResponseInit> {
  const date = isDate(req.query.get("date")) ? req.query.get("date")! : etToday();
  const [dayRows, all] = await Promise.all([
    listByPartition<ShadowRow>(TABLES.SPY_SHADOW, date),
    listAll<ShadowRow>(TABLES.SPY_SHADOW),
  ]);
  dayRows.sort((a, b) => a.rowKey.localeCompare(b.rowKey));
  const ledger: LedgerRow[] = all.map((r) => ({ day: r.day, side: r.side, status: r.status, entry: r.entry ?? null, grossUsd: r.grossUsd ?? null, netUsd: r.netUsd ?? null, exitReason: r.exitReason ?? "" }));
  const strip = (r: ShadowRow) => {
    const { partitionKey: _p, rowKey: _k, ...rest } = r as ShadowRow & { partitionKey: string; rowKey: string };
    void _p; void _k;
    // Account sizing is derived here, never stored, so a different account size
    // is a one-line change that re-prices the whole history consistently.
    const acct = rest.status === "FILLED" && rest.entry !== null && rest.grossUsd !== null
      ? sizeForAccount(rest.entry, rest.grossUsd) : null;
    // Same rule for the per-contract net: current commission, not the stored one.
    const netUsd = rest.status === "FILLED" && rest.grossUsd !== null
      ? Math.round((rest.grossUsd - RULE.COMMISSION_RT) * 100) / 100 : rest.netUsd;
    return { ...rest, netUsd, acct };
  };
  const lastEvaluated = all.reduce<string>((m, r) => (r.evaluatedAt > m ? r.evaluatedAt : m), "");
  return {
    jsonBody: {
      date, rule: RULE.label,
      params: { waitMin: RULE.WAIT_MIN, emaLen: RULE.EMA_LEN, targetPct: RULE.TARGET_PCT, stopPct: RULE.STOP_PCT, commissionRt: RULE.COMMISSION_RT, accountUsd: RULE.ACCOUNT_USD },
      rows: dayRows.map(strip),
      summary: summarize(ledger),
      lastEvaluated: lastEvaluated || null,
      firstDay: all.length ? all.map((r) => r.day).sort()[0] : null,
    },
    headers: { "Cache-Control": "no-store" },
  };
}

app.http("spyShadow", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "spy-shadow",
  handler: async (req, ctx) => {
    try {
      return req.method === "POST" ? await evaluate(req, ctx) : await read(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      ctx.error(`spy-shadow error: ${message}`);
      return { status: 500, jsonBody: { error: message } };
    }
  },
});
