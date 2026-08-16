/* eslint-disable no-console */
/**
 * WhatsApp Sidecar — drains alerts from an Azure Storage Queue and sends them
 * via whatsapp-web.js logged in as the user's "sender" WhatsApp number.
 *
 * Setup (one-time):
 *   1. cd tools/whatsapp-sidecar && npm install
 *   2. Copy .env.example → .env, fill AZURE_STORAGE_CONNECTION_STRING
 *   3. node src/index.js
 *   4. Scan the QR code shown in terminal with the sender phone's WhatsApp
 *      → Linked Devices → Link a device.
 *   5. Session is cached under .wwebjs_auth/. Subsequent starts skip QR.
 *   6. Register with Windows Task Scheduler (see README.md) so it auto-starts
 *      on login.
 *
 * Queue payload format (base64-encoded JSON):
 *   { "to": "14155552671", "text": "...", "meta": {...} }
 */

require("dotenv").config();
const { QueueClient } = require("@azure/storage-queue");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const QUEUE_NAME = process.env.WHATSAPP_QUEUE_NAME || "whatsapp-alerts";
const POLL_INTERVAL_MS = 60_000;
const VISIBILITY_TIMEOUT_S = 30;
const MAX_CONSECUTIVE_SEND_FAILURES = 3;
// Browser/page errors that mean the puppeteer session is unrecoverable. Retrying
// against a dead page never heals (2026-07-08: a detached frame wedged delivery
// silently for a full day), so on these we exit and let Task Scheduler relaunch
// with a fresh browser — the same recovery the "disconnected" handler uses.
const FATAL_SEND_ERROR = /detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|page has been closed/i;

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!connStr) {
  console.error("AZURE_STORAGE_CONNECTION_STRING not set");
  process.exit(1);
}

const queue = new QueueClient(connStr, QUEUE_NAME);
let waReady = false;

const wa = new Client({
  authStrategy: new LocalAuth({ clientId: "mtfrev-sidecar" }),
  puppeteer: { headless: true, args: ["--no-sandbox"] },
});

wa.on("qr", (qr) => {
  console.log("\nScan this QR with the sender phone (WhatsApp → Linked Devices):");
  qrcode.generate(qr, { small: true });
});

wa.on("ready", async () => {
  waReady = true;
  console.log("WhatsApp client ready. Draining queue every", POLL_INTERVAL_MS / 1000, "s.");
  await queue.createIfNotExists();
  pollLoop().catch((err) => {
    console.error("Poll loop crashed:", err);
    process.exit(1);
  });
});

wa.on("auth_failure", (msg) => console.error("WA auth failure:", msg));
wa.on("disconnected", (reason) => {
  console.error("WA disconnected:", reason);
  process.exit(1); // Task Scheduler will restart
});

async function sendOne(payload) {
  const { to, text } = payload;
  if (!to || !text) {
    console.warn("Skipping malformed payload:", payload);
    return;
  }
  const chatId = `${String(to).replace(/[^0-9]/g, "")}@c.us`;
  await wa.sendMessage(chatId, text);
  console.log(`Sent to ${to}: ${text.slice(0, 80)}`);
}

let consecutiveSendFailures = 0;

function bailOut(reason) {
  console.error(`FATAL: ${reason} — exiting so Task Scheduler restarts with a fresh browser.`);
  process.exit(1);
}

async function drainOnce() {
  if (!waReady) return;
  const resp = await queue.receiveMessages({
    numberOfMessages: 32,
    visibilityTimeout: VISIBILITY_TIMEOUT_S,
  });
  if (!resp.receivedMessageItems || resp.receivedMessageItems.length === 0) return;

  for (const msg of resp.receivedMessageItems) {
    // A malformed payload can never succeed — drop it instead of leaving it to
    // wedge the queue (and skew the consecutive-failure count) forever.
    let payload;
    try {
      payload = JSON.parse(Buffer.from(msg.messageText, "base64").toString("utf-8"));
    } catch (err) {
      console.error("Dropping malformed queue message:", err.message);
      await queue.deleteMessage(msg.messageId, msg.popReceipt).catch(() => {});
      continue;
    }

    try {
      await sendOne(payload);
      await queue.deleteMessage(msg.messageId, msg.popReceipt);
      consecutiveSendFailures = 0;
    } catch (err) {
      consecutiveSendFailures += 1;
      console.error(`Send failed (${consecutiveSendFailures} in a row); leaving message visible to retry:`, err);
      if (FATAL_SEND_ERROR.test(String((err && err.message) || err))) {
        bailOut("unrecoverable browser/page error");
      }
      if (consecutiveSendFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        bailOut(`${consecutiveSendFailures} consecutive send failures`);
      }
    }
  }
}

async function pollLoop() {
  while (true) {
    try {
      await drainOnce();
    } catch (err) {
      console.error("drainOnce error:", err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

console.log("Initializing WhatsApp client...");
wa.initialize();
