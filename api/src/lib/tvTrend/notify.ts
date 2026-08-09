import { enqueueWhatsApp } from "../queue.js";
import { sendPushoverMessage } from "../pushover.js";

/**
 * One place that turns a decision into a message on both channels.
 *
 * Shared by the webhook and the regime timer — a regime flip closes a position
 * just as a streak does, and an exit must read identically whichever noticed it.
 *
 * Both channels are best-effort with short timeouts: the webhook caller is
 * TradingView, which cancels at 3s, so a slow Pushover must never eat that.
 */
export async function notifyBoth(
  title: string,
  body: string,
  kind: string,
  meta: Record<string, unknown> = {},
): Promise<{ pushover: boolean; whatsapp: boolean }> {
  const [pushover, whatsapp] = await Promise.all([
    sendPushoverMessage(title, body, 1, 1200),
    enqueueWhatsApp({
      to: process.env.WHATSAPP_RECEIVER || "",
      text: body,
      meta: { kind, ...meta },
    })
      .then(() => true)
      .catch(() => false),
  ]);
  return { pushover, whatsapp };
}
