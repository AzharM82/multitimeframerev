import { enqueueWhatsApp } from "./queue.js";
import { sendPushoverMessage } from "./pushover.js";

/**
 * One place that turns a decision into a message on both channels.
 *
 * Both are best-effort with short timeouts: the caller is usually TradingView,
 * which cancels at 3s, so a slow Pushover must never eat that budget. A failure
 * is reported, never thrown — a DNS blip must not turn into a non-2xx that
 * TradingView retries, which would deliver the same alert twice for a reason
 * that has nothing to do with the alert.
 */
export async function notifyBoth(
  title: string,
  body: string,
  kind: string,
  meta: Record<string, unknown> = {},
): Promise<{ pushover: boolean; whatsapp: boolean }> {
  /**
   * No recipient means no enqueue. An empty `to` is not a message that fails —
   * it is a message the sidecar accepts and can never deliver, so it accumulates
   * in the queue looking like traffic. That is how a local run against the
   * shared production storage poisons the real alert channel.
   */
  const to = (process.env.WHATSAPP_RECEIVER || "").trim();

  const [pushover, whatsapp] = await Promise.all([
    sendPushoverMessage(title, body, 1, 1200),
    to
      ? enqueueWhatsApp({ to, text: body, meta: { kind, ...meta } })
          .then(() => true)
          .catch(() => false)
      : Promise.resolve(false),
  ]);
  return { pushover, whatsapp };
}
