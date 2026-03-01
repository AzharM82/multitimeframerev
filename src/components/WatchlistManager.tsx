import { useState, useCallback } from "react";
import type { StockScan } from "../types.js";
import * as api from "../services/api.js";

interface Props {
  tickers: string[];
  stocks: StockScan[];
  onUpdate: () => void;
}

export function WatchlistManager({ tickers, stocks, onUpdate }: Props) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const highVol = stocks.filter((s) => s.volatility === "high").length;
  const lowVol = stocks.filter((s) => s.volatility === "low").length;

  const handleAdd = useCallback(async () => {
    const parsed = input
      .split(/[\s,;\n]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (parsed.length === 0) return;

    setLoading(true);
    try {
      await api.addTickers(parsed);
      setInput("");
      onUpdate();
    } finally {
      setLoading(false);
    }
  }, [input, onUpdate]);

  const handleReplace = useCallback(async () => {
    const parsed = input
      .split(/[\s,;\n]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (parsed.length === 0) return;

    setLoading(true);
    try {
      await api.addTickers(parsed, true);
      setInput("");
      onUpdate();
    } finally {
      setLoading(false);
    }
  }, [input, onUpdate]);

  const handleRemove = useCallback(
    async (ticker: string) => {
      await api.removeTicker(ticker);
      onUpdate();
    },
    [onUpdate],
  );

  return (
    <div className="bg-bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary">
          Watchlist
        </h2>
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">
            HI: {highVol}
          </span>
          <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-400">
            LO: {lowVol}
          </span>
          <span className="text-text-secondary">{tickers.length} total</span>
        </div>
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
      </div>

      <div className="flex flex-wrap gap-1.5">
        {tickers.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-bg-secondary border border-border rounded text-xs text-text-primary"
          >
            {t}
            <button
              onClick={() => handleRemove(t)}
              className="text-text-secondary hover:text-signal-bear ml-0.5"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
