import { useState, useEffect, useCallback } from "react";
import type { StockScan } from "./types.js";
import { getWatchlist } from "./services/api.js";
import { useMarketHours } from "./hooks/useMarketHours.js";
import { useScanPolling } from "./hooks/useScanPolling.js";
import { useNotifications } from "./hooks/useNotifications.js";
import { WatchlistManager } from "./components/WatchlistManager.js";
import { ConfluenceGrid } from "./components/ConfluenceGrid.js";
import { NotificationLog } from "./components/NotificationLog.js";

function App() {
  const [tickers, setTickers] = useState<string[]>([]);
  const marketOpen = useMarketHours();

  const { data, loading, error, refresh, status } = useScanPolling();

  const stocks: StockScan[] = data?.stocks ?? [];
  const { entries } = useNotifications(stocks);

  const loadWatchlist = useCallback(async () => {
    try {
      const wl = await getWatchlist();
      setTickers(wl.tickers);
    } catch {
      // API not available yet
    }
  }, []);

  useEffect(() => {
    loadWatchlist();
  }, [loadWatchlist]);

  const handleWatchlistUpdate = useCallback(() => {
    loadWatchlist();
  }, [loadWatchlist]);

  const confluenceCount = stocks.filter((s) => s.confluence).length;

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <header className="border-b border-border bg-bg-secondary px-6 py-3">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-text-primary">
              Multi-Timeframe Reversal Scanner
            </h1>
            <span
              className={`w-2 h-2 rounded-full ${marketOpen ? "bg-signal-bull animate-pulse" : "bg-signal-bear"}`}
              title={marketOpen ? "Market Open" : "Market Closed"}
            />
            <span className="text-xs text-text-secondary">
              {marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {confluenceCount > 0 && (
              <span className="px-2 py-1 text-xs font-bold bg-accent/20 text-accent rounded animate-pulse">
                {confluenceCount} CONFLUENCE{confluenceCount > 1 ? "S" : ""}
              </span>
            )}

            <button
              onClick={refresh}
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
      </header>

      {/* Status Bar */}
      {loading && status && (
        <div className="bg-bg-secondary border-b border-border px-6 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent" />
              </span>
              <span className="text-sm text-accent font-medium">{status.message}</span>
            </div>
            {status.totalTickers > 0 && (
              <div className="flex-1 max-w-xs">
                <div className="h-1.5 bg-bg-card rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.max(5, (status.completedTickers.length / status.totalTickers) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {status.totalTickers > 0 && (
              <span className="text-xs text-text-secondary">
                {status.completedTickers.length}/{status.totalTickers}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Completed status message */}
      {!loading && status && !status.scanning && status.message !== "Idle" && (
        <div className="bg-bg-secondary border-b border-border px-6 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-signal-bull" />
            <span className="text-sm text-signal-bull">{status.message}</span>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        {error && (
          <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">
            {error}
          </div>
        )}

        {/* Watchlist */}
        <WatchlistManager
          tickers={tickers}
          stocks={stocks}
          onUpdate={handleWatchlistUpdate}
        />

        {/* Confluence Grid */}
        <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
              Reversal Signals
            </h2>
            {data && (
              <span className="text-xs text-text-secondary">
                Last scan: {new Date(data.scannedAt).toLocaleTimeString()}
                {data.marketOpen ? "" : " (delayed)"}
              </span>
            )}
          </div>
          <ConfluenceGrid stocks={stocks} loading={loading} />
        </div>

        {/* Notification Log */}
        <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
              Alert Log
            </h2>
          </div>
          <NotificationLog entries={entries} />
        </div>

        {/* Legend */}
        <div className="flex items-center gap-6 text-xs text-text-secondary">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-signal-bull" /> Bullish
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-signal-bear" /> Bearish
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-signal-neutral" /> Neutral (EMA)
          </span>
          <span>▲ = Bullish reversal | ▼ = Bearish reversal | — = No signal</span>
        </div>
      </main>
    </div>
  );
}

export default App;
