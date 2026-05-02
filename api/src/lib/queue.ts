/**
 * Azure Storage Queue helper — used by dayTradeTimer to fan out WhatsApp
 * alerts to the local sidecar (whatsapp-web.js).
 */

import { QueueClient } from "@azure/storage-queue";

const QUEUE_NAME = process.env.WHATSAPP_QUEUE_NAME || "whatsapp-alerts";
let client: QueueClient | null = null;
let ensured = false;

function getClient(): QueueClient {
  if (client) return client;
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  client = new QueueClient(connStr, QUEUE_NAME);
  return client;
}

async function ensureQueue(): Promise<void> {
  if (ensured) return;
  await getClient().createIfNotExists();
  ensured = true;
}

export interface WhatsAppMessage {
  to: string;            // E.164 phone, no plus
  text: string;
  meta?: Record<string, unknown>;
}

export async function enqueueWhatsApp(msg: WhatsAppMessage): Promise<void> {
  await ensureQueue();
  // Queue messages are base64-encoded by default — use base64 to be safe with emoji
  const payload = Buffer.from(JSON.stringify(msg), "utf-8").toString("base64");
  await getClient().sendMessage(payload);
}
