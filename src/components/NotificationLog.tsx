import type { NotificationEntry } from "../types.js";

interface Props {
  entries: NotificationEntry[];
}

export function NotificationLog({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <div className="p-4 text-text-secondary text-sm text-center">
        No alerts yet. Confluence signals will appear here.
      </div>
    );
  }

  return (
    <div className="max-h-48 overflow-y-auto">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`px-3 py-2 border-b border-border flex items-center gap-2 text-sm ${
            entry.type === "bullish" ? "text-signal-bull" : "text-signal-bear"
          }`}
        >
          <span className="font-mono text-xs text-text-secondary">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
          <span className="font-bold">{entry.ticker}</span>
          <span className="text-text-secondary">{entry.message}</span>
        </div>
      ))}
    </div>
  );
}
