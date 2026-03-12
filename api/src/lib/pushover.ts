import type { CapitulationSignal, CapitulationTier } from "./capitulationEngine.js";

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

function formatMessage(signal: CapitulationSignal, phase: Phase): string {
  const phaseLabel = phase === "morning"
    ? "Morning Burst 9:30-10:00"
    : "Extended 10:00-16:00";

  return (
    `${signal.ticker} gapped ${signal.gapPct.toFixed(1)}% | recovering +${signal.recoveryPct.toFixed(1)}%\n` +
    `Price: $${signal.price.toFixed(2)} | RVOL: ${signal.rvol.toFixed(1)}x\n` +
    `[${phaseLabel}]`
  );
}

function getPriority(tier: CapitulationTier): number {
  // CRITICAL → priority 1 (high, bypasses quiet hours)
  // HIGH → priority 0 (normal)
  return tier === "CRITICAL" ? 1 : 0;
}

export async function sendCapitulationAlerts(
  signals: CapitulationSignal[],
  phase: Phase,
): Promise<PushoverResult[]> {
  // Filter signals by phase
  const eligible = signals.filter((s) => {
    if (phase === "morning") return s.tier === "CRITICAL" || s.tier === "HIGH";
    return s.tier === "CRITICAL"; // extended phase: CRITICAL only
  });

  const results: PushoverResult[] = [];

  for (const signal of eligible) {
    try {
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN!,
        user: process.env.PUSHOVER_USER_KEY!,
        title: `${signal.tier}: ${signal.ticker}`,
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
