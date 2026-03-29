import { useState, useCallback } from "react";
import type { ScreenerRow } from "../types.js";
import { fetchScreener, type ScreenerType } from "../services/api.js";

const TABS: { key: ScreenerType; label: string }[] = [
  { key: "qullamaggie", label: "Qullamaggie" },
  { key: "minervini", label: "Minervini" },
  { key: "oneil", label: "O'Neil" },
];

const TAB_DESCRIPTIONS: Record<ScreenerType, { title: string; body: string }> = {
  qullamaggie: {
    title: "Kristjan Qullamaggie Setups",
    body: "Scans for three momentum patterns: Episodic Pivots (EP) \u2014 stocks gapping up 10%+ on 2x relative volume, often driven by earnings or news catalysts. Parabolic Shorts (PS) \u2014 large and small-cap stocks that have run 50-300%+ over 4 weeks and are candidates for a mean-reversion short. Breakouts (BO) \u2014 stocks within 25% of their 52-week high with 30%+ gains over 4 weeks and trading 10%+ above the 20-day SMA.",
  },
  minervini: {
    title: "Mark Minervini Trend Template",
    body: "Filters for stocks in a confirmed Stage 2 uptrend using Minervini\u2019s strict criteria: price above the 150-day and 200-day SMA, both SMAs rising, 50-day SMA above both, price at least 30% above the 52-week low and within 25% of the 52-week high, and RSI(14) at or above 70. Only the strongest trending stocks pass all eight conditions.",
  },
  oneil: {
    title: "William O\u2019Neil CAN SLIM",
    body: "Screens for fundamentally strong growth stocks based on CAN SLIM principles: current and annual EPS growth above 25%, positive trailing-twelve-month earnings, positive net profit margin, and positive return on equity. Results are further filtered to stocks where ROE + Net Margin combined exceed 25%, highlighting companies with superior profitability.",
  },
};

function formatVolume(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : v;
  if (isNaN(n)) return "\u2014";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function changeColor(change: string): string {
  const n = parseFloat(change);
  if (isNaN(n)) return "";
  return n >= 0 ? "text-signal-bull" : "text-signal-bear";
}

export function ScreenerPage() {
  const [tab, setTab] = useState<ScreenerType>("qullamaggie");
  const [data, setData] = useState<Record<ScreenerType, ScreenerRow[]>>({
    qullamaggie: [],
    minervini: [],
    oneil: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Record<ScreenerType, string | null>>({
    qullamaggie: null,
    minervini: null,
    oneil: null,
  });

  const load = useCallback(
    async (type: ScreenerType, force = false) => {
      // Skip if already loaded and not forcing refresh
      if (!force && data[type].length > 0) return;

      setLoading(true);
      setError(null);
      try {
        const rows = await fetchScreener(type, force);
        setData((prev) => ({ ...prev, [type]: rows }));
        setLastFetched((prev) => ({ ...prev, [type]: new Date().toLocaleTimeString() }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch screener data");
      } finally {
        setLoading(false);
      }
    },
    [data],
  );

  const handleTabChange = useCallback(
    (type: ScreenerType) => {
      setTab(type);
      load(type);
    },
    [load],
  );

  const handleRefresh = useCallback(() => {
    load(tab, true);
  }, [load, tab]);

  const rows = data[tab];

  return (
    <div className="space-y-4">
      {/* Header card with tabs + refresh */}
      <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => handleTabChange(t.key)}
                className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wider transition-colors border-b-2 ${
                  tab === t.key
                    ? "text-accent border-accent"
                    : "text-text-secondary border-transparent hover:text-text-primary"
                }`}
              >
                {t.label}
                {data[t.key].length > 0 && (
                  <span className="ml-1.5 text-xs font-normal text-text-secondary">
                    ({data[t.key].length})
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {lastFetched[tab] && (
              <span className="text-xs text-text-secondary">
                Last: {lastFetched[tab]}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={loading}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                loading
                  ? "bg-bg-card border border-border text-text-secondary opacity-50 cursor-not-allowed"
                  : "bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30"
              }`}
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>

        {/* Description */}
        <div className="px-4 py-3 border-b border-border/50 bg-bg-primary/30">
          <p className="text-xs font-semibold text-text-primary mb-1">
            {TAB_DESCRIPTIONS[tab].title}
          </p>
          <p className="text-xs text-text-secondary leading-relaxed">
            {TAB_DESCRIPTIONS[tab].body}
          </p>
        </div>

        {error && (
          <div className="px-4 py-2 bg-signal-bear/10 border-b border-signal-bear/30 text-signal-bear text-sm">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto max-h-[calc(100vh-220px)]">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 z-10 bg-bg-secondary">
                <th className="text-left px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  Ticker
                </th>
                <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  Price
                </th>
                <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  Chg%
                </th>
                <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  Vol
                </th>
                <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  Avg Vol
                </th>
                <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  Rel Vol
                </th>
                <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                  ATR%
                </th>
                {tab === "qullamaggie" && (
                  <th className="text-center px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                    Tag
                  </th>
                )}
                {tab === "oneil" && (
                  <>
                    <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                      ROE
                    </th>
                    <th className="text-right px-3 py-2 font-semibold text-text-secondary border-b border-border whitespace-nowrap">
                      Net Margin
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.ticker}
                  className="hover:bg-bg-secondary/50 transition-colors"
                >
                  <td className="text-left px-3 py-1.5 border-b border-border/50 whitespace-nowrap">
                    <a
                      href={`https://www.tradingview.com/chart/?symbol=${row.ticker}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline font-medium"
                    >
                      {row.ticker}
                    </a>
                  </td>
                  <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-primary">
                    {row.price}
                  </td>
                  <td
                    className={`text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono ${changeColor(row.change)}`}
                  >
                    {row.change}
                  </td>
                  <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-secondary">
                    {formatVolume(row.volume)}
                  </td>
                  <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-secondary">
                    {formatVolume(row.avg_vol)}
                  </td>
                  <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-secondary">
                    {row.rel_vol || "\u2014"}
                  </td>
                  <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-secondary">
                    {row.atr_pct != null ? `${row.atr_pct.toFixed(2)}%` : "\u2014"}
                  </td>
                  {tab === "qullamaggie" && (
                    <td className="text-center px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-medium text-amber-400">
                      {row.tag ?? "\u2014"}
                    </td>
                  )}
                  {tab === "oneil" && (
                    <>
                      <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-secondary">
                        {row.roe != null ? `${row.roe.toFixed(1)}%` : "\u2014"}
                      </td>
                      <td className="text-right px-3 py-1.5 border-b border-border/50 whitespace-nowrap font-mono text-text-secondary">
                        {row.net_margin != null ? `${row.net_margin.toFixed(1)}%` : "\u2014"}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={99}
                    className="text-center py-8 text-text-secondary"
                  >
                    {error
                      ? "Error loading data"
                      : "Click Refresh to load screener data"}
                  </td>
                </tr>
              )}
              {loading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={99}
                    className="text-center py-8 text-text-secondary"
                  >
                    <span className="animate-pulse">Loading screener data...</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      {tab === "qullamaggie" && (
        <div className="flex items-center gap-6 text-xs text-text-secondary">
          <span>
            <span className="text-amber-400 font-medium">EP</span> = Episodic
            Pivot (gap up 10%+, 2x vol)
          </span>
          <span>
            <span className="text-amber-400 font-medium">PS</span> = Parabolic
            Short
          </span>
          <span>
            <span className="text-amber-400 font-medium">BO</span> = Breakout
            (52W high, 30%+ 4-week)
          </span>
        </div>
      )}
    </div>
  );
}
