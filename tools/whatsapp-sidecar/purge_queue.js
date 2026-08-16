/* eslint-disable no-console */
/**
 * Queue helper for the WhatsApp sidecar.
 *
 *   node purge_queue.js          → report approximateMessagesCount only (safe)
 *   node purge_queue.js --purge  → report, then clearMessages() (destructive)
 *
 * Purge before restarting a sidecar that has been down: otherwise it drains the
 * whole backlog at once and blasts stale intraday alerts to the phone.
 * Uses the shared-key connection string from .env — no `az login`/MFA needed.
 */

require("dotenv").config();
const { QueueClient } = require("@azure/storage-queue");

const QUEUE_NAME = process.env.WHATSAPP_QUEUE_NAME || "whatsapp-alerts";
const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!connStr) {
  console.error("AZURE_STORAGE_CONNECTION_STRING not set");
  process.exit(1);
}

const purge = process.argv.includes("--purge");

(async () => {
  const queue = new QueueClient(connStr, QUEUE_NAME);
  const { approximateMessagesCount: depth } = await queue.getProperties();
  console.log(`queue=${QUEUE_NAME} depth=${depth}`);

  if (!purge) {
    console.log("Read-only. Pass --purge to delete every message.");
    return;
  }
  if (!depth) {
    console.log("Nothing to purge.");
    return;
  }
  await queue.clearMessages();
  const after = (await queue.getProperties()).approximateMessagesCount;
  console.log(`Purged ${depth} message(s). depth now=${after}`);
})().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
