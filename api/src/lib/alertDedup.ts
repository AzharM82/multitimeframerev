/**
 * In-memory alert deduplication.
 *
 * Tracks the last time an alert was sent for each ticker.
 * If the same ticker fires again within the cooldown window (default 30 min / 6 runs),
 * it is suppressed.
 *
 * The cache lives in-process, so it resets on cold starts — acceptable
 * trade-off (worst case: one extra alert after a cold start).
 */

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes (3 runs × 5 min)

// Separate caches for daily vs weekly so they don't interfere
const dailyCache = new Map<string, number>();
const weeklyCache = new Map<string, number>();

function pruneCache(cache: Map<string, number>): void {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [ticker, ts] of cache) {
    if (ts < cutoff) cache.delete(ticker);
  }
}

/**
 * Returns only tickers that haven't been alerted within the cooldown window.
 */
export function filterRecentlyAlerted<T extends { ticker: string }>(
  signals: T[],
  type: "daily" | "weekly",
): { eligible: T[]; suppressed: T[] } {
  const cache = type === "daily" ? dailyCache : weeklyCache;
  pruneCache(cache);

  const now = Date.now();
  const eligible: T[] = [];
  const suppressed: T[] = [];

  for (const signal of signals) {
    const lastAlerted = cache.get(signal.ticker);
    if (lastAlerted && now - lastAlerted < COOLDOWN_MS) {
      suppressed.push(signal);
    } else {
      eligible.push(signal);
    }
  }

  return { eligible, suppressed };
}

/**
 * Record that alerts were successfully sent for these tickers.
 * Call AFTER sending so that failed sends can retry next run.
 */
export function recordAlertsSent(
  tickers: string[],
  type: "daily" | "weekly",
): void {
  const cache = type === "daily" ? dailyCache : weeklyCache;
  const now = Date.now();
  for (const ticker of tickers) {
    cache.set(ticker, now);
  }
}
