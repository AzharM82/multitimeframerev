import { useState, useEffect, useCallback, useRef } from "react";
import type { WeeklyCapSignal, WeeklyCapScanResponse, WeeklyCapTier } from "../types.js";
import { runWeeklyCapitulationScan } from "../services/api.js";
import { useMarketHours } from "../hooks/useMarketHours.js";

type TierFilter = "ALL" | WeeklyCapTier;

const TIER_COLORS: Record<WeeklyCapTier, { bg: string; text: string; border: string }> = {
  CRITICAL: { bg: "bg-red-500/20", text: "text-red-400", border: "border-red-500/40" },
  HIGH: { bg: "bg-orange-500/20", text: "text-orange-400", border: "border-orange-500/40" },
  WATCH: { bg: "bg-yellow-500/20", text: "text-yellow-400", border: "border-yellow-500/40" },
};

export function WeeklyCapitulationPage() {
  const [data, setData] = useState<WeeklyCapScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>("ALL");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const marketOpen = useMarketHours();

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runWeeklyCapitulationScan();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh every 60s when market is open
  useEffect(() => {
    if (marketOpen) {
      scan();
      intervalRef.current = setInterval(scan, 60_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [marketOpen, scan]);

  const signals = data?.signals ?? [];
  const filtered = tierFilter === "ALL" ? signals : signals.filter((s) => s.tier === tierFilter);

  const criticalCount = signals.filter((s) => s.tier === "CRITICAL").length;
  const highCount = signals.filter((s) => s.tier === "HIGH").length;
  const watchCount = signals.filter((s) => s.tier === "WATCH").length;

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">
          {error}
        </div>
      )}

      {/* Info Bar */}
      <div className="bg-bg-card rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm text-text-secondary">
              Monitoring <span className="text-text-primary font-bold">{data?.totalScanned ?? 1105}</span> tickers
              <span className="text-text-secondary ml-1">(5-day drop)</span>
            </span>
            {data && (
              <>
                <span className="text-xs text-text-secondary">
                  Last scan: {new Date(data.scannedAt).toLocaleTimeString()}
                </span>
                <span className="text-xs text-text-secondary">
                  Duration: {data.scanDurationMs}ms
                </span>
              </>
            )}
          </div>
          <button
            onClick={scan}
            disabled={loading}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              loading
                ? "bg-bg-card border border-border text-text-secondary opacity-50 cursor-not-allowed"
                : "bg-signal-bull/20 text-signal-bull border border-signal-bull/40 hover:bg-signal-bull/30"
            }`}
          >
            {loading ? "Scanning..." : "Scan Now"}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Total Signals" value={signals.length} color="text-text-primary" />
        <SummaryCard label="CRITICAL" value={criticalCount} color="text-red-400" />
        <SummaryCard label="HIGH" value={highCount} color="text-orange-400" />
        <SummaryCard label="WATCH" value={watchCount} color="text-yellow-400" />
      </div>

      {/* Results */}
      <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
            Weekly Capitulation Signals
          </h2>
          <div className="flex gap-1">
            {(["ALL", "CRITICAL", "HIGH", "WATCH"] as TierFilter[]).map((t) => (
              <button
                key={t}
                onClick={() => setTierFilter(t)}
                className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded transition-colors ${
                  tierFilter === t
                    ? "bg-accent/20 text-accent"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {loading && !data ? (
          <div className="p-8 text-center text-text-secondary text-sm">Scanning 1,105 tickers...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-text-secondary text-sm">
            {signals.length === 0
              ? "No weekly capitulation signals detected. Signals appear when stocks drop 10%+ over the last 5 trading days."
              : `No ${tierFilter} signals found.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-text-secondary uppercase tracking-wider">
                  <th className="px-4 py-2 text-left">Tier</th>
                  <th className="px-4 py-2 text-left">Ticker</th>
                  <th className="px-4 py-2 text-right">Price</th>
                  <th className="px-4 py-2 text-right">5d Ago</th>
                  <th className="px-4 py-2 text-right">5-Day Drop</th>
                  <th className="px-4 py-2 text-right">Chg from Open</th>
                  <th className="px-4 py-2 text-right">RVOL</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((signal) => (
                  <SignalRow key={signal.ticker} signal={signal} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="bg-bg-card rounded-lg border border-border p-4 text-xs text-text-secondary space-y-2">
        <div className="font-bold uppercase tracking-wider text-text-secondary mb-1">Tier Thresholds (5-Day Drop)</div>
        <div className="flex flex-wrap gap-6">
          <span>
            <span className="inline-block px-1.5 py-px rounded bg-red-500/20 text-red-400 font-bold mr-1">CRITICAL</span>
            Drop &ge; 15%
          </span>
          <span>
            <span className="inline-block px-1.5 py-px rounded bg-orange-500/20 text-orange-400 font-bold mr-1">HIGH</span>
            Drop 12%–15%
          </span>
          <span>
            <span className="inline-block px-1.5 py-px rounded bg-yellow-500/20 text-yellow-400 font-bold mr-1">WATCH</span>
            Drop 10%–12%
          </span>
        </div>
        <div className="mt-1">
          Compares current price to close price from 5 trading days ago. Stocks only (ETFs excluded).
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-bg-card rounded-lg border border-border p-4">
      <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function SignalRow({ signal }: { signal: WeeklyCapSignal }) {
  const tier = TIER_COLORS[signal.tier];
  const chgFromOpen = signal.changeFromOpenPct;
  const isPositive = chgFromOpen > 0;
  return (
    <tr className={`border-t border-border hover:bg-bg-secondary/50 transition-colors ${signal.capitulating ? "bg-green-500/5" : ""}`}>
      <td className="px-4 py-2">
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${tier.bg} ${tier.text} border ${tier.border}`}>
          {signal.tier}
        </span>
      </td>
      <td className="px-4 py-2 font-bold text-text-primary">
        {signal.ticker}
        {signal.capitulating && (
          <span className="ml-1.5 text-[10px] text-green-400 font-medium">BOUNCE</span>
        )}
      </td>
      <td className="px-4 py-2 text-right text-text-primary">${signal.price.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-text-secondary">${signal.close5dAgo.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-red-400 font-medium">{signal.dropPct.toFixed(2)}%</td>
      <td className={`px-4 py-2 text-right font-medium ${isPositive ? "text-green-400" : "text-red-400"}`}>
        {isPositive ? "+" : ""}{chgFromOpen.toFixed(2)}%
      </td>
      <td className="px-4 py-2 text-right text-text-primary">{signal.rvol.toFixed(1)}x</td>
    </tr>
  );
}
