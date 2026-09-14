/**
 * WhatsApp + Pushover from the cron Function App.
 *
 * A port of the API's `lib/notifyBoth.ts`, not a new channel: the same Azure
 * Storage queue (`whatsapp-alerts`) that the local whatsapp-web.js sidecar
 * drains, and the same Pushover credentials. It exists here only because the
 * intraday poll runs in this Function App rather than behind the SWA API, and
 * this app has no build step to share TypeScript with.
 *
 * Behaviour copied deliberately, including the parts that look defensive:
 *
 *  - Best effort, never throws. An alert channel being down must not fail the
 *    poll; the market does not stop because Pushover did.
 *  - No recipient means no enqueue. An empty `to` is not a message that fails,
 *    it is a message the sidecar accepts and can never deliver, so it piles up
 *    in the queue looking like traffic. That is how a local run against shared
 *    production storage poisons the real alert channel.
 *  - `dryRun` returns what would have been sent without sending it, so the
 *    whole path can be exercised against production storage without a phone
 *    buzzing. Every by-hand script in this folder uses it.
 */

"use strict";

const { QueueClient } = require("@azure/storage-queue");

const QUEUE_NAME = process.env.WHATSAPP_QUEUE_NAME || "whatsapp-alerts";
const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

let queue = null;
let ensured = false;

async function getQueue() {
  if (!queue) {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
    queue = new QueueClient(conn, QUEUE_NAME);
  }
  if (!ensured) { await queue.createIfNotExists(); ensured = true; }
  return queue;
}

async function enqueueWhatsApp(to, text, meta) {
  const q = await getQueue();
  // The sidecar reads base64 — the queue encodes that way by default, and emoji
  // in a message body would otherwise be mangled.
  const payload = Buffer.from(JSON.stringify({ to, text, meta }), "utf-8").toString("base64");
  await q.sendMessage(payload);
}

async function sendPushover(title, message, priority = 0, timeoutMs = 4000) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return false;
  try {
    const res = await fetch(PUSHOVER_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, user, title, message, priority: String(priority) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when a message could actually reach someone. */
function notifyConfigured() {
  return Boolean(
    (process.env.WHATSAPP_RECEIVER || "").trim() ||
    (process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY),
  );
}

async function notifyBoth(title, body, kind, meta = {}, { dryRun = false } = {}) {
  const to = (process.env.WHATSAPP_RECEIVER || "").trim();
  if (dryRun) return { dryRun: true, pushover: false, whatsapp: false, wouldSendTo: to ? "whatsapp+pushover" : "pushover" };

  const [pushover, whatsapp] = await Promise.all([
    sendPushover(title, body, 0),
    to
      ? enqueueWhatsApp(to, `${title}\n${body}`, { kind, ...meta }).then(() => true).catch(() => false)
      : Promise.resolve(false),
  ]);
  return { pushover, whatsapp };
}

module.exports = { notifyBoth, notifyConfigured };
