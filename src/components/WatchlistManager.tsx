import { useState, useCallback } from "react";
import type { StockScan, WatchlistEntry } from "../types.js";
import * as api from "../services/api.js";

const CATEGORIES: { label: string; side: "bull" | "bear" }[] = [
  { label: "Squeeze Fired", side: "bull" },
  { label: "Bull Close", side: "bull" },
  { label: "Power of 3 - Bull", side: "bull" },
  { label: "21 SMA Range - Bull", side: "bull" },
  { label: "Signal Daily - Bull", side: "bull" },
  { label: "Bear Close", side: "bear" },
  { label: "Power of 3 - Bear", side: "bear" },
  { label: "21 SMA Range - Bear", side: "bear" },
  { label: "Signal Daily - Bear", side: "bear" },
  { label: "Universe", side: "bull" },
];

const BULL_CATEGORIES = new Set(
  CATEGORIES.filter((c) => c.side === "bull").map((c) => c.label),
);

interface Props {
  tickers: WatchlistEntry[];
  stocks: StockScan[];
  onUpdate: () => void;
}

export function WatchlistManager({ tickers, stocks, onUpdate }: Props) {
  const [input, setInput] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0].label);
  const [loading, setLoading] = useState(false);

  const highVol = stocks.filter((s) => s.volatility === "high").length;
  const lowVol = stocks.filter((s) => s.volatility === "low").length;

  const parseEntries = (): WatchlistEntry[] =>
    input
      .split(/[\s,;\n]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .map((ticker) => ({ ticker, category }));

  const handleAdd = useCallback(async () => {
    const entries = parseEntries();
    if (entries.length === 0) return;

    setLoading(true);
    try {
      await api.addTickers(entries);
      setInput("");
      onUpdate();
    } finally {
      setLoading(false);
    }
  }, [input, category, onUpdate]);

  const handleReplace = useCallback(async () => {
    const entries = parseEntries();
    if (entries.length === 0) return;

    setLoading(true);
    try {
      await api.addTickers(entries, true);
      setInput("");
      onUpdate();
    } finally {
      setLoading(false);
    }
  }, [input, category, onUpdate]);

  const handleClear = useCallback(async () => {
    setLoading(true);
    try {
      await api.addTickers([], true);
      onUpdate();
    } finally {
      setLoading(false);
    }
  }, [onUpdate]);

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
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="bg-bg-primary border border-border rounded px-2 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
        >
          {CATEGORIES.map((c) => (
            <option key={c.label} value={c.label}>
              {c.label}
            </option>
          ))}
        </select>
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
        {tickers.map((entry) => {
          const isBull = BULL_CATEGORIES.has(entry.category);
          const badgeColor = entry.category
            ? isBull
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-red-500/20 text-red-400"
            : "";
          return (
            <span
              key={entry.ticker}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-bg-secondary border border-border rounded text-xs text-text-primary"
            >
              {entry.ticker}
              {entry.category && (
                <span className={`px-1 py-px rounded text-[10px] ${badgeColor}`}>
                  {entry.category}
                </span>
              )}
              <button
                onClick={() => handleRemove(entry.ticker)}
                className="text-text-secondary hover:text-signal-bear ml-0.5"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
