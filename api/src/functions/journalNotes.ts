import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { upsert, listByPartition, TABLES } from "../lib/tables.js";

/**
 * Journal — the notes side.
 *
 *   GET  /api/journal-notes?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   POST /api/journal-notes   { date, underlying, text }
 *
 * One note per (trade date, underlying), NOT per day. The standalone journal
 * app keyed notes by date alone — one empty box for a 40-fill day — and
 * produced 3 notes in 501 trading days. Asking "how did AAPL go today" is a
 * question you can actually answer.
 *
 * Notes are dictated (OpenWhispr, Ctrl+Shift+R, types into the focused field),
 * so they arrive as one long unpunctuated blob. Stored verbatim; the summariser
 * does the tidying.
 *
 * AUTH, and why GET is not simply anonymous: the summariser on the trading
 * desktop has to read these, but they are private trading notes, so the route
 * cannot just be added to the SWA anonymous allowlist the way the machine-only
 * endpoints are. GET is allowlisted at the SWA edge and then gated INSIDE the
 * handler: a signed-in browser is identified by the `x-ms-client-principal`
 * header SWA injects for any authenticated session, and the local job presents
 * the timer secret. Anything else gets a 401. POST stays behind the SWA
 * `portal` role — only the browser writes notes.
 */

const MAX_TEXT = 20_000;

interface NoteRow {
  rowKey: string;
  text?: string;
  updatedAt?: string;
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function save(req: HttpRequest): Promise<HttpResponseInit> {
  const body = (await req.json()) as { date?: string; underlying?: string; text?: string };
  const date = (body.date ?? "").trim();
  const underlying = (body.underlying ?? "").trim().toUpperCase();

  if (!isDate(date)) return { status: 400, jsonBody: { error: "date must be YYYY-MM-DD" } };
  if (!/^[A-Z.\-]{1,12}$/.test(underlying)) return { status: 400, jsonBody: { error: "invalid underlying" } };

  const text = (body.text ?? "").slice(0, MAX_TEXT);
  const updatedAt = new Date().toISOString();
  await upsert(TABLES.JOURNAL_NOTES, date, underlying, { text, updatedAt });

  return { jsonBody: { status: "ok", date, underlying, updatedAt } };
}

/** A signed-in portal session, or the local summariser. Nothing else. */
function mayRead(req: HttpRequest): boolean {
  if (req.headers.get("x-ms-client-principal")) return true;
  const secret = req.headers.get("x-timer-secret");
  return !!process.env.TIMER_SECRET && secret === process.env.TIMER_SECRET;
}

async function read(req: HttpRequest): Promise<HttpResponseInit> {
  if (!mayRead(req)) return { status: 401, jsonBody: { error: "Unauthorized" } };

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const rawFrom = (req.query.get("from") || "").trim();
  const rawTo = (req.query.get("to") || "").trim();
  const from = isDate(rawFrom) ? rawFrom : "2026-08-03";
  const to = isDate(rawTo) ? rawTo : today;

  const notes: Array<{ date: string; underlying: string; text: string; updatedAt: string }> = [];
  for (const date of dateRange(from, to)) {
    for (const r of await listByPartition<NoteRow>(TABLES.JOURNAL_NOTES, date)) {
      if (!r.text) continue;
      notes.push({ date, underlying: r.rowKey, text: r.text, updatedAt: r.updatedAt ?? "" });
    }
  }

  return { jsonBody: { from, to, count: notes.length, notes } };
}

async function journalNotes(req: HttpRequest): Promise<HttpResponseInit> {
  try {
    return req.method === "POST" ? await save(req) : await read(req);
  } catch (err) {
    return { status: 500, jsonBody: { error: err instanceof Error ? err.message : "Unknown error" } };
  }
}

app.http("journalNotes", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "journal-notes",
  handler: journalNotes,
});
