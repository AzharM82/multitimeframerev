/* eslint-disable no-console */
/**
 * Re-pair the sidecar's WhatsApp session (session cache expires ~every 14 days).
 *
 *   1. Stop the "WA Sidecar" task first — two clients on one LocalAuth profile
 *      corrupt it.
 *   2. node pair.js
 *   3. Scan qr.png (written next to this file) with the sender phone:
 *      WhatsApp → Linked Devices → Link a device.
 *
 * Why this exists rather than scanning the terminal QR: the ASCII QR is
 * unreliable to scan, and — the real trap — killing the process right after
 * `ready` CORRUPTS the session and forces another re-scan. This shuts down via
 * wa.destroy() so the LocalAuth profile is flushed cleanly.
 */

require("dotenv").config();
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrterm = require("qrcode-terminal");

const QR_PNG = path.join(__dirname, "qr.png");

const wa = new Client({
  authStrategy: new LocalAuth({ clientId: "mtfrev-sidecar" }),
  puppeteer: { headless: true, args: ["--no-sandbox"] },
});

wa.on("qr", async (qr) => {
  qrterm.generate(qr, { small: true });
  try {
    const qrcode = require("qrcode");
    await qrcode.toFile(QR_PNG, qr, { width: 512, margin: 2 });
    console.log(`\nQR also written to ${QR_PNG} — open it and scan.`);
  } catch (err) {
    console.warn("Could not write qr.png, scan the ASCII QR above:", err.message);
  }
});

wa.on("authenticated", () => console.log("Authenticated — writing session..."));
wa.on("auth_failure", (msg) => {
  console.error("Auth failure:", msg);
  process.exit(1);
});

wa.on("ready", async () => {
  console.log("WhatsApp client ready. Shutting down GRACEFULLY (do not Ctrl+C).");
  // The whole point of this helper: destroy() flushes the LocalAuth profile.
  // Exiting any other way here leaves a corrupt session behind.
  await wa.destroy();
  console.log("Session saved. Start the 'WA Sidecar' task again.");
  process.exit(0);
});

console.log("Initializing — a QR should appear shortly...");
wa.initialize();
