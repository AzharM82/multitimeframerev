import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { CapitulationSignal, CapitulationScanResponse } from "../types.js";
import { runCapitulationScan } from "../services/api.js";
import { useMarketHours } from "../hooks/useMarketHours.js";
import { CapitulationWatchlistManager } from "./CapitulationWatchlistManager.js";

type SortKey = "ticker" | "prevClose" | "open" | "price" | "gapPct" | "changePct" | "recoveryPct" | "rvol";
type SortDir = "asc" | "desc";

export function CapitulationPage() {
  const [data, setData] = useState<CapitulationScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickerCount, setTickerCount] = useState<number | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("recoveryPct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
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

  const sorted = useMemo(() => {
    const arr = [...signals];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "prevClose": cmp = a.prevClose - b.prevClose; break;
        case "open": cmp = a.open - b.open; break;
        case "price": cmp = a.price - b.price; break;
        case "gapPct": cmp = a.gapPct - b.gapPct; break;
        case "changePct": cmp = a.changePct - b.changePct; break;
        case "recoveryPct": cmp = a.recoveryPct - b.recoveryPct; break;
        case "rvol": cmp = a.rvol - b.rvol; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [signals, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  };

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

      {/* Summary */}
      <div className="bg-bg-card rounded-lg border border-border p-4">
        <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Total Signals</div>
        <div className="text-2xl font-bold text-text-primary">{signals.length}</div>
      </div>

      {/* Results */}
      <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
            Daily Cap Signals — Gap &ge; 1% down, recovering from open
          </h2>
        </div>

        {loading && !data ? (
          <div className="p-8 text-center text-text-secondary text-sm">Scanning tickers...</div>
        ) : sorted.length === 0 ? (
          <div className="p-8 text-center text-text-secondary text-sm">
            No capitulation signals detected. Signals appear when stocks gap down &ge; 1% and recover from open.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-text-secondary uppercase tracking-wider">
                  <SortHeader label="Ticker" sortKey="ticker" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} align="left" />
                  <SortHeader label="Prev Close" sortKey="prevClose" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Open" sortKey="open" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Price" sortKey="price" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="Gap Down" sortKey="gapPct" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="% Change" sortKey="changePct" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="% Chg Open" sortKey="recoveryPct" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
                  <SortHeader label="RVOL" sortKey="rvol" current={sortKey} dir={sortDir} onClick={handleSort} indicator={sortIndicator} />
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

function SignalRow({ signal }: { signal: CapitulationSignal }) {
  return (
    <tr className="border-t border-border hover:bg-bg-secondary/50 transition-colors">
      <td className="px-4 py-2 font-bold text-text-primary">{signal.ticker}</td>
      <td className="px-4 py-2 text-right text-text-secondary">${signal.prevClose.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-text-secondary">${signal.open.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-text-primary">${signal.price.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-red-400 font-medium">{signal.gapPct.toFixed(2)}%</td>
      <td className={`px-4 py-2 text-right font-medium ${signal.changePct >= 0 ? "text-green-400" : "text-red-400"}`}>
        {signal.changePct >= 0 ? "+" : ""}{signal.changePct.toFixed(2)}%
      </td>
      <td className={`px-4 py-2 text-right font-medium ${signal.recoveryPct >= 0 ? "text-green-400" : "text-red-400"}`}>
        {signal.recoveryPct >= 0 ? "+" : ""}{signal.recoveryPct.toFixed(2)}%
      </td>
      <td className="px-4 py-2 text-right text-text-primary">{signal.rvol.toFixed(1)}x</td>
    </tr>
  );
}
