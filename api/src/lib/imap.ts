/**
 * IMAP poller for the bull-signal inbox (Gmail or Outlook).
 *
 * Subject format from TOS: "Alert: New symbol: TICKER was added to D-Bull-Sig"
 * Filter: subject must contain "D-Bull-Sig" (case-insensitive).
 * Extract: ticker via /New symbol:\s*([A-Z]+)\s+was added to/i.
 * After successful parse, mark message as \Seen so it isn't re-processed.
 *
 * Env vars (preferred):
 *   BULL_INBOX_USER, BULL_INBOX_PASSWORD, BULL_INBOX_HOST (default imap.gmail.com)
 * Legacy fallback:
 *   OUTLOOK_USER + OUTLOOK_APP_PASSWORD → host outlook.office365.com
 */

import { ImapFlow } from "imapflow";

const DEFAULT_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const FILTER_RE = /D-Bull-Sig/i;
// Handles both forms:
//   "Alert: New symbol: AAPL was added to D-Bull-Sig"
//   "Alert: New symbols: A, ABBV, ACN, ... YSS were added to D-Bull-Sig."
const TICKERS_RE = /New symbols?:\s*(.+?)\s+(?:was|were)\s+added to\s+D-Bull-Sig/i;

export interface BullAlertParsed {
  ticker: string;
  uid: number;
  receivedAt: string;
  subject: string;
}

function extractTickers(subject: string): string[] {
  const m = TICKERS_RE.exec(subject);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z]{1,6}(\.[A-Z])?$/.test(t));
}

function getConfig(): { user: string; pass: string; host: string } {
  const user = process.env.BULL_INBOX_USER ?? process.env.OUTLOOK_USER;
  const pass = process.env.BULL_INBOX_PASSWORD ?? process.env.OUTLOOK_APP_PASSWORD;
  const host = process.env.BULL_INBOX_HOST
    ?? (process.env.OUTLOOK_USER && !process.env.BULL_INBOX_USER ? "outlook.office365.com" : DEFAULT_HOST);
  if (!user || !pass) throw new Error("BULL_INBOX_USER / BULL_INBOX_PASSWORD not set (or legacy OUTLOOK_USER / OUTLOOK_APP_PASSWORD)");
  return { user, pass, host };
}

export async function fetchBullAlerts(opts?: { lookbackDays?: number; debug?: boolean; folder?: string }): Promise<BullAlertParsed[]> {
  const { user, pass, host } = getConfig();
  const client = new ImapFlow({
    host,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const out: BullAlertParsed[] = [];
  await client.connect();
  try {
    const folder = opts?.folder ?? "INBOX";
    const lock = await client.getMailboxLock(folder);
    try {
      const search: Record<string, unknown> = {};
      if (opts?.lookbackDays && opts.lookbackDays > 0) {
        const since = new Date();
        since.setDate(since.getDate() - opts.lookbackDays);
        search.since = since;
      } else {
        search.seen = false;
      }
      const uids = await client.search(search, { uid: true });
      if (!uids || uids.length === 0) return out;

      if (opts?.debug) {
        const dbg: BullAlertParsed[] = [];
        for await (const msg of client.fetch(uids, { envelope: true, uid: true, internalDate: true }, { uid: true })) {
          const raw = msg.internalDate ?? new Date();
          dbg.push({
            ticker: "?",
            uid: msg.uid,
            receivedAt: (typeof raw === "string" ? new Date(raw) : raw).toISOString(),
            subject: msg.envelope?.subject ?? "(no subject)",
          });
        }
        return dbg;
      }

      for await (const msg of client.fetch(
        uids,
        { envelope: true, uid: true, internalDate: true },
        { uid: true },
      )) {
        const subject = msg.envelope?.subject ?? "";
        if (!FILTER_RE.test(subject)) continue;
        const tickers = extractTickers(subject);
        if (tickers.length === 0) continue;
        const raw = msg.internalDate ?? new Date();
        const receivedAt = (typeof raw === "string" ? new Date(raw) : raw).toISOString();
        for (const ticker of tickers) {
          out.push({ ticker, uid: msg.uid, receivedAt, subject });
        }
      }

      // Mark processed messages as Seen so we skip them next poll.
      // Skip flagging during backfill (lookbackDays mode) so we don't change
      // the user's read state across historical messages.
      if (!opts?.lookbackDays && !opts?.debug) {
        const matchedUids = Array.from(new Set(out.map((a) => a.uid)));
        if (matchedUids.length > 0) {
          await client.messageFlagsAdd(matchedUids, ["\\Seen"], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return out;
}
