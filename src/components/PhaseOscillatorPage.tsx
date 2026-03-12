import { useState, useEffect, useCallback } from "react";
import type { PhaseStockResult, WatchlistEntry } from "../types.js";
import * as api from "../services/api.js";
import { PhaseGrid } from "./PhaseGrid.js";

export function PhaseOscillatorPage() {
  const [tickers, setTickers] = useState<WatchlistEntry[]>([]);
  const [input, setInput] = useState("");
  const [stocks, setStocks] = useState<PhaseStockResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<string | null>(null);

  const loadWatchlist = useCallback(async () => {
    try {
      const wl = await api.getPhaseWatchlist();
      setTickers(wl.tickers);
    } catch {
      // API not available yet
    }
  }, []);

  useEffect(() => {
    loadWatchlist();
  }, [loadWatchlist]);

  const parseInput = (): WatchlistEntry[] =>
    input
      .split(/[\s,;\n]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .map((ticker) => ({ ticker, category: "" }));

  const handleAdd = useCallback(async () => {
    const entries = parseInput();
    if (entries.length === 0) return;
    setLoading(true);
    try {
      await api.addPhaseTickers(entries);
      setInput("");
      loadWatchlist();
    } finally {
      setLoading(false);
    }
  }, [input, loadWatchlist]);

  const handleReplace = useCallback(async () => {
    const entries = parseInput();
    if (entries.length === 0) return;
    setLoading(true);
    try {
      await api.addPhaseTickers(entries, true);
      setInput("");
      loadWatchlist();
    } finally {
      setLoading(false);
    }
  }, [input, loadWatchlist]);

  const handleClear = useCallback(async () => {
    setLoading(true);
    try {
      await api.addPhaseTickers([], true);
      loadWatchlist();
    } finally {
      setLoading(false);
    }
  }, [loadWatchlist]);

  const handleRemove = useCallback(
    async (ticker: string) => {
      await api.removePhaseTicker(ticker);
      loadWatchlist();
    },
    [loadWatchlist],
  );

  const handleScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await api.runPhaseScan();
      setStocks(result.stocks);
      setLastScan(result.scannedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">
          {error}
        </div>
      )}

      {/* Watchlist Input */}
      <div className="bg-bg-card rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
            Phase Scanner Watchlist
          </h2>
          <span className="text-xs text-text-secondary">{tickers.length} tickers</span>
        </div>

        <div className="flex gap-2 mb-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste tickers (AAPL, TSLA, NVDA...)"
            className="flex-1 bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder-text-secondary resize-none h-10 focus:outline-none focus:border-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <button
            onClick={handleAdd}
            disabled={loading}
            className="px-3 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/80 disabled:opacity-50 transition-colors"
          >
            Add
          </button>
          <button
            onClick={handleReplace}
            disabled={loading}
            className="px-3 py-2 bg-bg-secondary border border-border text-text-secondary rounded text-sm hover:text-text-primary transition-colors"
          >
            Replace All
          </button>
          <button
            onClick={handleClear}
            disabled={loading}
            className="px-3 py-2 bg-signal-bear/20 border border-signal-bear/40 text-signal-bear rounded text-sm hover:bg-signal-bear/30 transition-colors"
          >
            Clear
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {tickers.map((entry) => (
            <span
              key={entry.ticker}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-bg-secondary border border-border rounded text-xs text-text-primary"
            >
              {entry.ticker}
              <button
                onClick={() => handleRemove(entry.ticker)}
                className="text-text-secondary hover:text-signal-bear ml-0.5"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Scan Results */}
      <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
            Phase Oscillator Results
          </h2>
          <div className="flex items-center gap-3">
            {lastScan && (
              <span className="text-xs text-text-secondary">
                Last scan: {new Date(lastScan).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={handleScan}
              disabled={scanning || tickers.length === 0}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                scanning || tickers.length === 0
                  ? "bg-bg-card border border-border text-text-secondary opacity-50 cursor-not-allowed"
                  : "bg-signal-bull/20 text-signal-bull border border-signal-bull/40 hover:bg-signal-bull/30"
              }`}
            >
              {scanning ? "Scanning..." : "Scan"}
            </button>
          </div>
        </div>
        <PhaseGrid stocks={stocks} loading={scanning} />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-text-secondary">
        <span className="px-1.5 py-px rounded bg-emerald-500/30 text-emerald-300 font-bold">BUY</span>
        <span>Oversold — oscillator leaving extreme down (&lt; -100)</span>
        <span className="px-1.5 py-px rounded bg-red-500/30 text-red-300 font-bold">SELL</span>
        <span>Overbought — oscillator leaving extreme up (&gt; 100)</span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-fuchsia-500" /> Compression
        </span>
      </div>
    </div>
  );
}
