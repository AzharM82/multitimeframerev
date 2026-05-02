import { useEffect, useState } from "react";
import type { BullListResponse, BullListRow, BullStatus } from "../types.js";
import { getBullList, deleteBullEntry } from "../services/api.js";

const STATUS_COLORS: Record<BullStatus, string> = {
  OPEN: "bg-accent/15 text-accent border-accent/40",
  TP_HIT: "bg-signal-bull/15 text-signal-bull border-signal-bull/40",
  SL_HIT: "bg-signal-bear/15 text-signal-bear border-signal-bear/40",
  EXPIRED: "bg-slate-500/15 text-slate-400 border-slate-500/40",
};

function pnlClass(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "text-text-secondary";
  if (pct > 0) return "text-signal-bull";
  if (pct < 0) return "text-signal-bear";
  return "text-text-secondary";
}

function Row({ row, onRemove }: { row: BullListRow; onRemove: () => void }) {
  return (
    <tr className="border-b border-border hover:bg-bg-secondary/40">
      <td className="py-2 px-3">
        <a
          href={`https://www.tradingview.com/chart/?symbol=${row.ticker}`}
          target="_blank"
          rel="noopener"
          className="font-bold text-accent hover:underline"
        >
          {row.ticker}
        </a>
      </td>
      <td className="py-2 px-3 text-right tabular-nums">${row.entry.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear/80">${row.sl.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bull/80">${row.tp.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums">
        {row.last !== undefined && row.last !== null ? `$${row.last.toFixed(2)}` : "—"}
      </td>
      <td className={`py-2 px-3 text-right tabular-nums font-semibold ${pnlClass(row.pnlPct)}`}>
        {row.pnlPct !== undefined && row.pnlPct !== null ? `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%` : "—"}
      </td>
      <td className="py-2 px-3 text-center">
        <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded ${STATUS_COLORS[row.status]}`}>
          {row.status}
        </span>
      </td>
      <td className="py-2 px-3 text-xs text-text-secondary">{new Date(row.addedAt).toLocaleString()}</td>
      <td className="py-2 px-3 text-right">
        <button
          onClick={onRemove}
          className="text-xs text-text-secondary hover:text-signal-bear"
          title="Remove"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

export function BullListPage() {
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [data, setData] = useState<BullListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    getBullList(tab)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function handleRemove(row: BullListRow) {
    if (!confirm(`Remove ${row.ticker}?`)) return;
    try {
      await deleteBullEntry(row.partitionKey, row.rowKey);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">TOS · D-Bull-Sig</div>
            <h2 className="text-xl font-bold mt-1">Bull List</h2>
          </div>
          <div className="text-xs text-text-secondary">
            Auto-ingested from <code className="text-accent">tosbullalerts@live.com</code> hourly.
            SL/TP computed via reversal pivot · Default TP +5%
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(["open", "closed"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wider border-b-2 transition-colors ${
              tab === t ? "text-accent border-accent" : "text-text-secondary border-transparent hover:text-text-primary"
            }`}
          >
            {t} {tab === t && data ? `(${data.count})` : ""}
          </button>
        ))}
      </div>

      {error && <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">{error}</div>}

      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <th className="py-2 px-3 text-left">Ticker</th>
              <th className="py-2 px-3 text-right">Entry</th>
              <th className="py-2 px-3 text-right">Stop</th>
              <th className="py-2 px-3 text-right">Target</th>
              <th className="py-2 px-3 text-right">Last</th>
              <th className="py-2 px-3 text-right">P&amp;L</th>
              <th className="py-2 px-3 text-center">Status</th>
              <th className="py-2 px-3 text-left">Added</th>
              <th className="py-2 px-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="py-8 text-center text-text-secondary text-sm">
                No {tab} positions.
              </td></tr>
            )}
            {!loading && rows.map((r) => <Row key={r.rowKey} row={r} onRemove={() => handleRemove(r)} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
