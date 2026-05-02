/**
 * IMAP poller for tosbullalerts@live.com (Outlook/Hotmail).
 *
 * Subject format from TOS: "Alert: New symbol: TICKER was added to D-Bull-Sig"
 * Filter: subject must contain "D-Bull-Sig" (case-insensitive).
 * Extract: ticker via /New symbol:\s*([A-Z]+)\s+was added to/i.
 * After successful parse, mark message as \Seen so it isn't re-processed.
 */

import { ImapFlow } from "imapflow";

const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;
const FILTER_RE = /D-Bull-Sig/i;
const TICKER_RE = /New symbol:\s*([A-Z]+)\s+was added to/i;

export interface BullAlertParsed {
  ticker: string;
  uid: number;
  receivedAt: string;
  subject: string;
}

function getCreds(): { user: string; pass: string } {
  const user = process.env.OUTLOOK_USER;
  const pass = process.env.OUTLOOK_APP_PASSWORD;
  if (!user || !pass) throw new Error("OUTLOOK_USER / OUTLOOK_APP_PASSWORD not set");
  return { user, pass };
}

export async function fetchBullAlerts(): Promise<BullAlertParsed[]> {
  const { user, pass } = getCreds();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const out: BullAlertParsed[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return out;

      for await (const msg of client.fetch(
        uids,
        { envelope: true, uid: true, internalDate: true },
        { uid: true },
      )) {
        const subject = msg.envelope?.subject ?? "";
        if (!FILTER_RE.test(subject)) continue;
        const m = TICKER_RE.exec(subject);
        if (!m) continue;
        const ticker = m[1].toUpperCase();
        const raw = msg.internalDate ?? new Date();
        const receivedAt = (typeof raw === "string" ? new Date(raw) : raw).toISOString();
        out.push({ ticker, uid: msg.uid, receivedAt, subject });
      }

      // Mark processed messages as Seen so we skip them next poll
      const matchedUids = out.map((a) => a.uid);
      if (matchedUids.length > 0) {
        await client.messageFlagsAdd(matchedUids, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return out;
}
