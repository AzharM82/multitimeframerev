import type { CapitulationSignal, CapitulationTier } from "./capitulationEngine.js";
import type { WeeklyCapSignal, WeeklyCapTier } from "./weeklyCapitulationEngine.js";
import { filterRecentlyAlerted, recordAlertsSent } from "./alertDedup.js";

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
  // Filter signals: CRITICAL and HIGH with >1% recovery from open
  const tierFiltered = signals.filter((s) => {
    return (s.tier === "CRITICAL" || s.tier === "HIGH") && s.recoveryPct > 1;
  });

  // Suppress tickers alerted within the last 30 minutes (6 runs)
  const { eligible, suppressed } = filterRecentlyAlerted(tierFiltered, "daily");
  const results: PushoverResult[] = suppressed.map((s) => ({
    ticker: s.ticker,
    tier: s.tier,
    success: true,
    error: "suppressed (alerted within last 30 min)",
  }));

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

  // Record successfully sent tickers so they get suppressed for 30 min
  const sentTickers = results
    .filter((r) => r.success && !r.error)
    .map((r) => r.ticker);
  recordAlertsSent(sentTickers, "daily");

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
  // Only alert when Change from Open is >1% (stock is bouncing = capitulating)
  const tierFiltered = signals.filter((s) => {
    if (s.changeFromOpenPct <= 1) return false; // skip if not recovering >1% from open
    return s.tier === "CRITICAL" || s.tier === "HIGH";
  });

  // Suppress tickers alerted within the last 30 minutes (6 runs)
  const { eligible, suppressed } = filterRecentlyAlerted(tierFiltered, "weekly");
  const results: PushoverResult[] = suppressed.map((s) => ({
    ticker: s.ticker,
    tier: s.tier,
    success: true,
    error: "suppressed (alerted within last 30 min)",
  }));

  for (const signal of eligible) {
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

  // Record successfully sent tickers so they get suppressed for 30 min
  const sentTickers = results
    .filter((r) => r.success && !r.error)
    .map((r) => r.ticker);
  recordAlertsSent(sentTickers, "weekly");

  return results;
}
