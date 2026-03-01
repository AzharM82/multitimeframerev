interface Props {
  confluence: "bullish" | "bearish" | null;
}

export function StatusBadge({ confluence }: Props) {
  if (!confluence) {
    return (
      <span className="px-2 py-1 text-xs rounded bg-bg-card text-text-secondary border border-border">
        Mixed
      </span>
    );
  }

  const isBull = confluence === "bullish";
  return (
    <span
      className={`px-2 py-1 text-xs font-bold rounded uppercase tracking-wide ${
        isBull
          ? "bg-signal-bull/20 text-signal-bull border border-signal-bull/40 animate-pulse"
          : "bg-signal-bear/20 text-signal-bear border border-signal-bear/40 animate-pulse"
      }`}
    >
      {isBull ? "BULLISH" : "BEARISH"} CONFLUENCE
    </span>
  );
}
