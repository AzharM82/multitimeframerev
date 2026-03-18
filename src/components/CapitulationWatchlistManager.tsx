import { useState, useEffect, useCallback, useRef } from "react";
import type { Watchlist } from "../types.js";
import { getCapitulationWatchlist, addCapitulationTickers, removeCapitulationTicker } from "../services/api.js";

interface Props {
  onTickerCountChange?: (count: number) => void;
  sharedNote?: string;
}

const PAGE_SIZE = 100;

export function CapitulationWatchlistManager({ onTickerCountChange, sharedNote }: Props) {
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const wl = await getCapitulationWatchlist();
      setWatchlist(wl);
      onTickerCountChange?.(wl.tickers.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load watchlist");
    } finally {
      setLoading(false);
    }
  }, [onTickerCountChange]);

  useEffect(() => { load(); }, [load]);

  const parseTickers = (text: string): string[] => {
    return text
      .split(/[\s,;\n]+/)
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0 && /^[A-Z-]+$/.test(t));
  };

  const handleAdd = async () => {
    const tickers = parseTickers(inputText);
    if (tickers.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const entries = tickers.map((t) => ({ ticker: t, category: "" }));
      const wl = await addCapitulationTickers(entries);
      setWatchlist(wl);
      onTickerCountChange?.(wl.tickers.length);
      setInputText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tickers");
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (ticker: string) => {
    setLoading(true);
    try {
      const wl = await removeCapitulationTicker(ticker);
      setWatchlist(wl);
      onTickerCountChange?.(wl.tickers.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove ticker");
    } finally {
      setLoading(false);
    }
  };

  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/);
      // Find ticker column from header
      const header = lines[0]?.toLowerCase().split(",") ?? [];
      let tickerCol = header.indexOf("ticker");
      if (tickerCol === -1) tickerCol = header.indexOf("symbol");
      if (tickerCol === -1) tickerCol = 0; // fallback to first column

      const tickers: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const t = cols[tickerCol]?.trim().toUpperCase();
        if (t && /^[A-Z-]+$/.test(t)) tickers.push(t);
      }

      if (tickers.length === 0) {
        setError("No valid tickers found in CSV");
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const entries = tickers.map((t) => ({ ticker: t, category: "" }));
        const wl = await addCapitulationTickers(entries, true); // replace=true
        setWatchlist(wl);
        onTickerCountChange?.(wl.tickers.length);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to upload CSV");
      } finally {
        setLoading(false);
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-uploaded
    e.target.value = "";
  };

  const allTickers = watchlist?.tickers ?? [];
  const filtered = search
    ? allTickers.filter((e) => e.ticker.includes(search.toUpperCase()))
    : allTickers;
  const displayed = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
  const hasMore = filtered.length > PAGE_SIZE && !showAll;

  return (
    <div className="space-y-3">
      {error && (
        <div className="p-2 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-xs">
          {error}
        </div>
      )}

      {sharedNote && (
        <div className="p-2 bg-accent/10 border border-accent/30 rounded text-accent text-xs">
          {sharedNote}
        </div>
      )}

      {/* Ticker count + actions */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-secondary">
          <span className="text-text-primary font-bold">{allTickers.length.toLocaleString()}</span> tickers in list
          {watchlist?.updatedAt && (
            <span className="ml-2 text-xs text-text-secondary">
              Updated: {new Date(watchlist.updatedAt).toLocaleString()}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleCSVUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="px-3 py-1 text-xs font-medium rounded bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition-colors disabled:opacity-50"
          >
            Upload CSV
          </button>
        </div>
      </div>

      {/* Add tickers manually */}
      <div className="flex gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add tickers: AAPL, TSLA, NVDA..."
          className="flex-1 px-3 py-1.5 text-sm bg-bg-secondary border border-border rounded text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
        />
        <button
          onClick={handleAdd}
          disabled={loading || !inputText.trim()}
          className="px-3 py-1.5 text-xs font-medium rounded bg-signal-bull/20 text-signal-bull border border-signal-bull/40 hover:bg-signal-bull/30 transition-colors disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {/* Search */}
      {allTickers.length > 20 && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tickers..."
          className="w-full px-3 py-1.5 text-sm bg-bg-secondary border border-border rounded text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
        />
      )}

      {/* Ticker list */}
      {allTickers.length > 0 && (
        <div className="flex flex-wrap gap-1 max-h-64 overflow-y-auto">
          {displayed.map((entry) => (
            <span
              key={entry.ticker}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-bg-secondary border border-border rounded text-text-primary"
            >
              {entry.ticker}
              <button
                onClick={() => handleRemove(entry.ticker)}
                className="text-text-secondary hover:text-signal-bear transition-colors ml-0.5"
                title="Remove"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}

      {hasMore && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-accent hover:underline"
        >
          Show all {filtered.length.toLocaleString()} tickers ({filtered.length - PAGE_SIZE} more)
        </button>
      )}
      {showAll && filtered.length > PAGE_SIZE && (
        <button
          onClick={() => setShowAll(false)}
          className="text-xs text-accent hover:underline"
        >
          Show first {PAGE_SIZE} only
        </button>
      )}
    </div>
  );
}
