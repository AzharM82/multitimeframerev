import type { CapitulationSignal, CapitulationTier } from "./capitulationEngine.js";
import type { WeeklyCapSignal, WeeklyCapTier } from "./weeklyCapitulationEngine.js";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

export interface PushoverResult {
  ticker: string;
  tier: CapitulationTier;
  success: boolean;
  error?: string;
}

type Phase = "morning" | "extended";

export function isPushoverConfigured(): boolean {
  return !!(process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN);
}

/**
 * Send one arbitrary Pushover notification. Best-effort: never throws, so an
 * alert channel being down cannot fail the caller's request.
 *
 * `timeoutMs` matters for webhook handlers — TradingView cancels a request that
 * takes over 3s, so a hung Pushover call must not eat that budget.
 */
export async function sendPushoverMessage(
  title: string,
  message: string,
  priority = 0,
  timeoutMs = 1500,
): Promise<boolean> {
  if (!isPushoverConfigured()) return false;
  try {
    const res = await fetch(PUSHOVER_API_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN!,
        user: process.env.PUSHOVER_USER_KEY!,
        title,
        message,
        priority: String(priority),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function formatMessage(signal: CapitulationSignal, phase: Phase): string {
  const phaseLabel = phase === "morning"
    ? "Morning Burst 9:30-10:00"
    : "Extended 10:00-16:00";

  return (
    `${signal.ticker} gapped ${signal.gapPct.toFixed(1)}% | from open ${signal.recoveryPct >= 0 ? "+" : ""}${signal.recoveryPct.toFixed(1)}%\n` +
    `Price: $${signal.price.toFixed(2)} | RVOL: ${signal.rvol.toFixed(1)}x\n` +
    `[${phaseLabel}]`
  );
}

function getPriority(tier: CapitulationTier): number {
  return tier === "CRITICAL" ? 1 : 0;
}

export async function sendCapitulationAlerts(
  signals: CapitulationSignal[],
  phase: Phase,
): Promise<PushoverResult[]> {
  // Signals already filtered by engine (gap <= -1%, recoveryPct > 0)
  const results: PushoverResult[] = [];

  for (const signal of signals) {
    try {
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN!,
        user: process.env.PUSHOVER_USER_KEY!,
        title: `DAILY ${signal.tier}: ${signal.ticker}`,
        message: formatMessage(signal, phase),
        priority: String(getPriority(signal.tier)),
      });

      const resp = await fetch(PUSHOVER_API_URL, {
        method: "POST",
        body,
      });

      if (!resp.ok) {
        const text = await resp.text();
        results.push({ ticker: signal.ticker, tier: signal.tier, success: false, error: text });
      } else {
        results.push({ ticker: signal.ticker, tier: signal.tier, success: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({ ticker: signal.ticker, tier: signal.tier, success: false, error: message });
    }
  }

  return results;
}

// ─── Weekly Capitulation Alerts ──────────────────────────────────────────────

function formatWeeklyMessage(signal: WeeklyCapSignal, phase: Phase): string {
  const phaseLabel = phase === "morning"
    ? "Morning Burst 9:30-10:00"
    : "Extended 10:00-16:00";

  return (
    `${signal.ticker} dropped ${signal.dropPct.toFixed(1)}% in 5 days | +${signal.changeFromOpenPct.toFixed(1)}% from open\n` +
    `Price: $${signal.price.toFixed(2)} (was $${signal.close5dAgo.toFixed(2)})\n` +
    `RVOL: ${signal.rvol.toFixed(1)}x\n` +
    `[${phaseLabel}]`
  );
}

function getWeeklyPriority(tier: WeeklyCapTier): number {
  return tier === "CRITICAL" ? 1 : 0;
}

export async function sendWeeklyCapitulationAlerts(
  signals: WeeklyCapSignal[],
  phase: Phase,
): Promise<PushoverResult[]> {
  // Signals already filtered by engine (drop >= 10%, changeFromOpenPct > 0)
  const results: PushoverResult[] = [];

  for (const signal of signals) {
    try {
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN!,
        user: process.env.PUSHOVER_USER_KEY!,
        title: `WEEKLY ${signal.tier}: ${signal.ticker}`,
        message: formatWeeklyMessage(signal, phase),
        priority: String(getWeeklyPriority(signal.tier)),
      });

      const resp = await fetch(PUSHOVER_API_URL, {
        method: "POST",
        body,
      });

      if (!resp.ok) {
        const text = await resp.text();
        results.push({ ticker: signal.ticker, tier: signal.tier, success: false, error: text });
      } else {
        results.push({ ticker: signal.ticker, tier: signal.tier, success: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({ ticker: signal.ticker, tier: signal.tier, success: false, error: message });
    }
  }

  return results;
}
