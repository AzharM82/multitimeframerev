import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { CapitulationSignal, CapitulationScanResponse, CapitulationTier } from "../types.js";
import { runCapitulationScan } from "../services/api.js";
import { useMarketHours } from "../hooks/useMarketHours.js";
import { CapitulationWatchlistManager } from "./CapitulationWatchlistManager.js";

type TierFilter = "ALL" | CapitulationTier;
type SortKey = "tier" | "ticker" | "prevClose" | "open" | "price" | "gapPct" | "recoveryPct" | "rvol" | "timeWeight";
type SortDir = "asc" | "desc";

const TIER_COLORS: Record<CapitulationTier, { bg: string; text: string; border: string }> = {
  CRITICAL: { bg: "bg-red-500/20", text: "text-red-400", border: "border-red-500/40" },
  HIGH: { bg: "bg-orange-500/20", text: "text-orange-400", border: "border-orange-500/40" },
  WATCH: { bg: "bg-yellow-500/20", text: "text-yellow-400", border: "border-yellow-500/40" },
};

const TIER_RANK: Record<CapitulationTier, number> = { CRITICAL: 0, HIGH: 1, WATCH: 2 };

export function CapitulationPage() {
  const [data, setData] = useState<CapitulationScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>("ALL");
  const [tickerCount, setTickerCount] = useState<number | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("tier");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const marketOpen = useMarketHours();

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCapitulationScan();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "tier": cmp = TIER_RANK[a.tier] - TIER_RANK[b.tier]; break;
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "prevClose": cmp = a.prevClose - b.prevClose; break;
        case "open": cmp = a.open - b.open; break;
        case "price": cmp = a.price - b.price; break;
        case "gapPct": cmp = a.gapPct - b.gapPct; break;
        case "recoveryPct": cmp = a.recoveryPct - b.recoveryPct; break;
        case "rvol": cmp = a.rvol - b.rvol; break;
        case "timeWeight": cmp = a.timeWeight - b.timeWeight; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "ticker" ? "asc" : "asc");
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  };

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
              Monitoring <span className="text-text-primary font-bold">{data?.totalScanned ?? tickerCount ?? "..."}</span> tickers
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowManager(!showManager)}
              className="px-3 py-1.5 rounded text-sm font-medium transition-colors bg-bg-secondary text-text-secondary border border-border hover:text-text-primary"
            >
              {showManager ? "Hide" : "Manage"} Tickers
            </button>
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
        {showManager && (
          <div className="mt-4 pt-4 border-t border-border">
            <CapitulationWatchlistManager onTickerCountChange={setTickerCount} />
          </div>
        )}
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
            Daily Cap Signals
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
          <div className="p-8 text-center text-text-secondary text-sm">Scanning tickers...</div>
        ) : sorted.length === 0 ? (
          <div className="p-8 text-center text-text-secondary text-sm">
            {signals.length === 0
              ? "No capitulation signals detected. Signals appear when stocks gap down from previous close."
              : `No ${tierFilter} signals found.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-text-secondary uppercase tracking-wider">
                  <SortHeader label="Tier" sortKey="tier" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} align="left" />
                  <SortHeader label="Ticker" sortKey="ticker" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} align="left" />
                  <SortHeader label="Prev Close" sortKey="prevClose" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Open" sortKey="open" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Price" sortKey="price" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Gap Down" sortKey="gapPct" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Chg from Open" sortKey="recoveryPct" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="RVOL" sortKey="rvol" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Time Wt" sortKey="timeWeight" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((signal) => (
                  <SignalRow key={signal.ticker} signal={signal} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="bg-bg-card rounded-lg border border-border p-4 text-xs text-text-secondary space-y-2">
        <div className="font-bold uppercase tracking-wider text-text-secondary mb-1">Tier Thresholds (Gap Down)</div>
        <div className="flex flex-wrap gap-6">
          <span>
            <span className="inline-block px-1.5 py-px rounded bg-red-500/20 text-red-400 font-bold mr-1">CRITICAL</span>
            Gap &gt; 5%
          </span>
          <span>
            <span className="inline-block px-1.5 py-px rounded bg-orange-500/20 text-orange-400 font-bold mr-1">HIGH</span>
            Gap 3%–5%
          </span>
          <span>
            <span className="inline-block px-1.5 py-px rounded bg-yellow-500/20 text-yellow-400 font-bold mr-1">WATCH</span>
            Gap 0%–3%
          </span>
        </div>
        <div className="mt-1">
          Time Weight: 2.0x (9:30-10:00) | 1.5x (10:00-10:30) | 1.2x (10:30-11:30) | 1.0x (11:30-14:00) | 0.8x (14:00-16:00)
        </div>
      </div>
    </div>
  );
}

function SortHeader({ label, sortKey: key, onClick, indicator, align = "right" }: {
  label: string; sortKey: SortKey; current?: SortKey; dir?: SortDir;
  onClick: (k: SortKey) => void; indicator: (k: SortKey) => string; align?: "left" | "right";
}) {
  return (
    <th
      className={`px-4 py-2 ${align === "left" ? "text-left" : "text-right"} cursor-pointer hover:text-text-primary select-none`}
      onClick={() => onClick(key)}
    >
      {label}{indicator(key)}
    </th>
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

function SignalRow({ signal }: { signal: CapitulationSignal }) {
  const tier = TIER_COLORS[signal.tier];
  return (
    <tr className="border-t border-border hover:bg-bg-secondary/50 transition-colors">
      <td className="px-4 py-2">
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${tier.bg} ${tier.text} border ${tier.border}`}>
          {signal.tier}
        </span>
      </td>
      <td className="px-4 py-2 font-bold text-text-primary">{signal.ticker}</td>
      <td className="px-4 py-2 text-right text-text-secondary">${signal.prevClose.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-text-secondary">${signal.open.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-text-primary">${signal.price.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-red-400 font-medium">{signal.gapPct.toFixed(2)}%</td>
      <td className={`px-4 py-2 text-right font-medium ${signal.recoveryPct >= 0 ? "text-green-400" : "text-red-400"}`}>
        {signal.recoveryPct >= 0 ? "+" : ""}{signal.recoveryPct.toFixed(2)}%
      </td>
      <td className="px-4 py-2 text-right text-text-primary">{signal.rvol.toFixed(1)}x</td>
      <td className="px-4 py-2 text-right text-text-secondary">{signal.timeWeight.toFixed(1)}x</td>
    </tr>
  );
}
