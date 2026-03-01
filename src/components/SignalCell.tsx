import type { TimeframeSignal } from "../types.js";

interface Props {
  signal: TimeframeSignal;
}

function formatBarTime(iso: string, timeframe: string): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: "America/Los_Angeles" };

  if (timeframe === "1W" || timeframe === "1D") {
    return new Date(iso).toLocaleDateString("en-US", {
      ...opts,
      month: "short",
      day: "numeric",
    });
  }
  // Intraday
  return new Date(iso).toLocaleTimeString("en-US", {
    ...opts,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function SignalCell({ signal }: Props) {
  const bgColor =
    signal.direction === "bullish"
      ? "bg-signal-bull/20 border-signal-bull/40"
      : signal.direction === "bearish"
        ? "bg-signal-bear/20 border-signal-bear/40"
        : "bg-bg-card border-border";

  const textColor =
    signal.direction === "bullish"
      ? "text-signal-bull"
      : signal.direction === "bearish"
        ? "text-signal-bear"
        : "text-text-secondary";

  const emaIndicator =
    signal.emaColor === "green"
      ? "bg-signal-bull"
      : signal.emaColor === "red"
        ? "bg-signal-bear"
        : "bg-signal-neutral";

  const arrow =
    signal.direction === "bullish" ? "▲" : signal.direction === "bearish" ? "▼" : "—";

  return (
    <td className={`px-3 py-2 border ${bgColor} text-center`}>
      <div className="flex items-center justify-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${emaIndicator}`} title={`EMA: ${signal.emaColor}`} />
        <span className={`font-bold text-sm ${textColor}`}>{arrow}</span>
      </div>
      {signal.reversalPrice && (
        <div className={`text-xs mt-0.5 ${textColor} opacity-70`}>
          ${signal.reversalPrice.toFixed(2)}
        </div>
      )}
      {signal.lastBarTime && (
        <div className="text-[10px] mt-0.5 text-text-secondary opacity-60">
          {formatBarTime(signal.lastBarTime, signal.timeframe)}
        </div>
      )}
    </td>
  );
}
