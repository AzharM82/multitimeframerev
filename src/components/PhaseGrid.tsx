import type { PhaseStockResult, PhaseTimeframe } from "../types.js";
import { PhaseCell } from "./PhaseCell.js";

const TIMEFRAMES: PhaseTimeframe[] = ["1W", "1D", "60m", "30m"];

interface Props {
  stocks: PhaseStockResult[];
  loading: boolean;
}

export function PhaseGrid({ stocks, loading }: Props) {
  if (loading) {
    return (
      <div className="px-4 py-8 text-center text-text-secondary text-sm">
        Scanning...
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-text-secondary text-sm">
        No results. Add tickers and run a scan.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-text-secondary text-xs uppercase tracking-wider">
            <th className="px-3 py-2 text-left">Ticker</th>
            <th className="px-3 py-2 text-right">Price</th>
            <th className="px-3 py-2 text-center">Score</th>
            {TIMEFRAMES.map((tf) => (
              <th key={tf} className="px-3 py-2 text-center">
                {tf}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => {
            const hasAnySignal = Object.values(stock.signals).some(
              (s) => s.signal !== null,
            );
            const scoreColor =
              stock.score > 0
                ? "text-emerald-400"
                : stock.score < 0
                  ? "text-red-400"
                  : "text-text-secondary";
            const scoreLabel =
              stock.score >= 7
                ? "STRONG BUY"
                : stock.score >= 4
                  ? "BUY"
                  : stock.score <= -7
                    ? "STRONG SELL"
                    : stock.score <= -4
                      ? "SELL"
                      : "";
            return (
              <tr
                key={stock.ticker}
                className={`border-b border-border/50 hover:bg-bg-secondary/50 transition-colors ${
                  hasAnySignal ? "ring-1 ring-yellow-400/30" : ""
                }`}
              >
                <td className="px-3 py-2 font-bold text-text-primary">
                  {stock.ticker}
                </td>
                <td className="px-3 py-2 text-right text-text-secondary font-mono">
                  ${stock.price.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-center">
                  <div className="flex flex-col items-center">
                    <span className={`font-mono font-bold ${scoreColor}`}>
                      {stock.score > 0 ? "+" : ""}{stock.score.toFixed(1)}
                    </span>
                    {scoreLabel && (
                      <span
                        className={`text-[10px] font-bold ${
                          stock.score > 0 ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {scoreLabel}
                      </span>
                    )}
                  </div>
                </td>
                {TIMEFRAMES.map((tf) => (
                  <PhaseCell key={tf} data={stock.signals[tf]} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
