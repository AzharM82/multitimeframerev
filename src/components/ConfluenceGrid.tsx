import type { StockScan } from "../types.js";
import { SignalCell } from "./SignalCell.js";
import { StatusBadge } from "./StatusBadge.js";

interface Props {
  stocks: StockScan[];
  loading: boolean;
}

export function ConfluenceGrid({ stocks, loading }: Props) {
  if (stocks.length === 0 && !loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-secondary">
        Add tickers to your watchlist to start scanning
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-text-secondary text-xs uppercase tracking-wider">
            <th className="px-3 py-2 text-left border border-border bg-bg-secondary">Ticker</th>
            <th className="px-3 py-2 text-right border border-border bg-bg-secondary">Price</th>
            <th className="px-3 py-2 text-right border border-border bg-bg-secondary">ATR</th>
            <th className="px-3 py-2 text-right border border-border bg-bg-secondary">RVOL</th>
            <th className="px-3 py-2 text-center border border-border bg-bg-secondary">Vol</th>
            <th className="px-3 py-2 text-left border border-border bg-bg-secondary">Industry</th>
            <th className="px-3 py-2 text-center border border-border bg-bg-secondary">Weekly</th>
            <th className="px-3 py-2 text-center border border-border bg-bg-secondary">Daily</th>
            <th className="px-3 py-2 text-center border border-border bg-bg-secondary">65m</th>
            <th className="px-3 py-2 text-center border border-border bg-bg-secondary">10m</th>
            <th className="px-3 py-2 text-center border border-border bg-bg-secondary">Status</th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => (
            <tr
              key={stock.ticker}
              className={`hover:bg-bg-secondary/50 transition-colors ${
                stock.confluence ? "ring-1 ring-inset " +
                  (stock.confluence === "bullish" ? "ring-signal-bull/30" : "ring-signal-bear/30") : ""
              }`}
            >
              <td className="px-3 py-2 border border-border font-bold text-text-primary">
                {stock.ticker}
              </td>
              <td className="px-3 py-2 border border-border text-right font-mono text-sm">
                ${stock.price.toFixed(2)}
              </td>
              <td className="px-3 py-2 border border-border text-right font-mono text-sm">
                {stock.atr.toFixed(2)}
              </td>
              <td className="px-3 py-2 border border-border text-right font-mono text-sm">
                <span
                  className={
                    stock.rvol >= 2
                      ? "text-accent font-bold"
                      : stock.rvol >= 1.5
                        ? "text-amber-400"
                        : "text-text-secondary"
                  }
                >
                  {stock.rvol.toFixed(1)}x
                </span>
              </td>
              <td className="px-3 py-2 border border-border text-center">
                <span
                  className={`px-1.5 py-0.5 text-xs rounded ${
                    stock.volatility === "high"
                      ? "bg-amber-500/20 text-amber-400"
                      : "bg-sky-500/20 text-sky-400"
                  }`}
                >
                  {stock.volatility === "high" ? "HI" : "LO"}
                </span>
              </td>
              <td className="px-3 py-2 border border-border text-left text-xs text-text-secondary truncate max-w-[160px]" title={stock.industry}>
                {stock.industry}
              </td>
              <SignalCell signal={stock.signals["1W"]} />
              <SignalCell signal={stock.signals["1D"]} />
              <SignalCell signal={stock.signals["65m"]} />
              <SignalCell signal={stock.signals["10m"]} />
              <td className="px-3 py-2 border border-border text-center">
                <StatusBadge confluence={stock.confluence} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && (
        <div className="text-center py-3 text-text-secondary text-sm animate-pulse">
          Scanning...
        </div>
      )}
    </div>
  );
}
