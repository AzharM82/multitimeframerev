/**
 * Opening Drive — shared record-and-alert.
 *
 * One place for the "a candidate changed state → stamp the row + fire the
 * highest-priority alerts" logic, called by BOTH the cloud engine
 * (openingDriveEngine) and the external trigger endpoint (openingDriveTrigger).
 * Keeping it here means the alert copy and the row shape can't drift between
 * the two entry points.
 */

import { upsert, getOne, TABLES } from "../tables.js";
import { isPushoverConfigured } from "../pushover.js";
import { enqueueWhatsApp } from "../queue.js";

export type TriggerState = "GATE_PASS" | "GATE_FAIL" | "TRIGGERED" | "STUFFED" | "EXIT";

export interface TriggerFields {
  entry?: number | null;
  stop?: number | null;
  pmHigh?: number | null;
  rvol?: number | null;
  riskPerShare?: number | null;
  suggestedShares?: number | null;
  exitReason?: string | null;
  catalystType?: string;
  catalystStrength?: string;
  headline?: string | null;
  regime?: string;
  spyPct?: number | null;
  sectorPct?: number | null;
  barTimeEt?: string;
}

async function sendPushover(title: string, message: string, priority: number): Promise<void> {
  if (!isPushoverConfigured()) return;
  try {
    await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN!,
        user: process.env.PUSHOVER_USER_KEY!,
        title,
        message,
        priority: String(priority),
      }),
    });
  } catch {
    /* alerts are best-effort */
  }
}

/**
 * Merge the new state onto the day's candidate row and, for TRIGGERED / EXIT,
 * fire Pushover (priority 1) + WhatsApp. Returns nothing; failures in the alert
 * channels never block the state write.
 */
export async function recordAndAlert(
  partition: string,
  ticker: string,
  state: TriggerState,
  fields: TriggerFields,
  firedAt: string = new Date().toISOString(),
): Promise<void> {
  // Merge onto the candidate payload written by Phase 1.
  const existing = await getOne<{ payloadJson?: string }>(TABLES.OPENING_DRIVE, partition, ticker);
  let candidate: Record<string, unknown> = {};
  if (existing?.payloadJson) {
    try { candidate = JSON.parse(existing.payloadJson); } catch { /* keep empty */ }
  }
  candidate.state = state;
  candidate.stateAt = firedAt;
  if (state === "TRIGGERED") {
    candidate.entry = fields.entry ?? null;
    candidate.stop = fields.stop ?? null;
    // Persisted so the next cycle's post-trigger monitor knows the breakout
    // level and stop without recomputing.
    candidate.pmHighUsed = fields.pmHigh ?? null;
    candidate.riskPerShare = fields.riskPerShare ?? null;
    candidate.suggestedShares = fields.suggestedShares ?? null;
    candidate.rvol = fields.rvol ?? null;
    candidate.triggerBarEt = fields.barTimeEt ?? null;
  }
  if (state === "EXIT") candidate.exitReason = fields.exitReason ?? null;

  await upsert(TABLES.OPENING_DRIVE, partition, ticker, {
    kind: "candidate",
    state,
    stateAt: firedAt,
    payloadJson: JSON.stringify(candidate),
  });

  if (state === "TRIGGERED") {
    const risk = fields.riskPerShare;
    const shares = fields.suggestedShares;
    const message =
      `OPENING DRIVE: ${ticker}\n` +
      `Entry ${fields.entry} | Stop ${fields.stop}` +
      (risk != null ? ` | Risk ${risk.toFixed(2)}/sh` : "") +
      (shares != null ? ` | ~${shares} sh` : "") + "\n" +
      `PMH ${fields.pmHigh} | RVOL ${fields.rvol}\n` +
      `Catalyst ${fields.catalystType ?? "?"}/${fields.catalystStrength ?? "?"}` +
      (fields.headline ? ` — "${fields.headline}"` : "") + "\n" +
      `Regime ${fields.regime ?? "?"} | SPY ${fields.spyPct ?? "?"}% | Sector ${fields.sectorPct ?? "?"}%`;
    await Promise.all([
      sendPushover(`OPENING DRIVE: ${ticker}`, message, 1),
      enqueueWhatsApp({ to: process.env.WHATSAPP_RECEIVER || "", text: message, meta: { kind: "opening-drive", ticker } }).catch(() => {}),
    ]);
  } else if (state === "EXIT") {
    const message = `OPENING DRIVE EXIT: ${ticker} — ${fields.exitReason ?? "exit signal"}`;
    await Promise.all([
      sendPushover(`OPENING DRIVE EXIT: ${ticker}`, message, 1),
      enqueueWhatsApp({ to: process.env.WHATSAPP_RECEIVER || "", text: message, meta: { kind: "opening-drive-exit", ticker } }).catch(() => {}),
    ]);
  }
}
