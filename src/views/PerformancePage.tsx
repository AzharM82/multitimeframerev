import { useEffect, useState } from "react";
import type { ClosedPaperTrade, OpenPaperTrade, PaperTradesResponse } from "../types.js";
import { getPaperTrades } from "../services/api.js";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-bg-card border border-border rounded-lg p-4">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-text-secondary mt-1">{sub}</div>}
    </div>
  );
}

function pnlClass(n: number): string {
  if (n > 0) return "text-signal-bull";
  if (n < 0) return "text-signal-bear";
  return "text-text-secondary";
}

function ClosedRow({ t }: { t: ClosedPaperTrade }) {
  return (
    <tr className="border-b border-border hover:bg-bg-secondary/40">
      <td className="py-2 px-3 font-bold text-accent">{t.ticker}</td>
      <td className="py-2 px-3 text-xs uppercase text-text-secondary">{t.source}</td>
      <td className="py-2 px-3 text-right tabular-nums">${t.entry.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums">${t.exit.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-text-secondary">{t.qty}</td>
      <td className={`py-2 px-3 text-right tabular-nums font-semibold ${pnlClass(t.pnlDollars)}`}>
        {t.pnlDollars >= 0 ? "+" : ""}${t.pnlDollars.toFixed(2)}
      </td>
      <td className={`py-2 px-3 text-right tabular-nums ${pnlClass(t.pnlPct)}`}>
        {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
      </td>
      <td className="py-2 px-3 text-xs text-text-secondary">{t.exitReason}</td>
      <td className="py-2 px-3 text-xs text-text-secondary">{new Date(t.closedAt).toLocaleDateString()}</td>
    </tr>
  );
}

function OpenRow({ t }: { t: OpenPaperTrade }) {
  return (
    <tr className="border-b border-border hover:bg-bg-secondary/40">
      <td className="py-2 px-3 font-bold text-accent">{t.ticker}</td>
      <td className="py-2 px-3 text-xs uppercase text-text-secondary">{t.source}</td>
      <td className="py-2 px-3 text-right tabular-nums">${t.entry.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear/80">${t.sl.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bull/80">${t.tp.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-text-secondary">{t.qty}</td>
      <td className="py-2 px-3 text-xs text-text-secondary">{new Date(t.openedAt).toLocaleDateString()}</td>
    </tr>
  );
}

export function PerformancePage() {
  const [data, setData] = useState<PaperTradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getPaperTrades()
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const stats = data?.stats;
  const open = data?.open ?? [];
  const closed = data?.closed ?? [];

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">$5,000 per trade · paper</div>
            <h2 className="text-xl font-bold mt-1">System Performance</h2>
          </div>
          <div className="text-xs text-text-secondary">
            Tracks Bull List entries through TP/SL/Expiry. Day-trade alert log shown below.
          </div>
        </div>
      </div>

      {error && <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">{error}</div>}

      {loading && <div className="text-center text-text-secondary py-8">Loading…</div>}

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Closed Trades" value={String(stats.totalTrades)} sub={`${stats.wins}W / ${stats.losses}L`} />
          <StatCard label="Win Rate" value={`${stats.winRate}%`} />
          <StatCard
            label="Total P&L"
            value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`}
            sub={`avg ${stats.avgPnl >= 0 ? "+" : ""}$${stats.avgPnl.toFixed(2)}`}
          />
          <StatCard
            label="Best / Worst %"
            value={`${stats.bestPct >= 0 ? "+" : ""}${stats.bestPct}% / ${stats.worstPct >= 0 ? "+" : ""}${stats.worstPct}%`}
          />
        </div>
      )}

      <h3 className="text-sm font-bold uppercase tracking-wider text-text-secondary mt-4">Open ({open.length})</h3>
      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <th className="py-2 px-3 text-left">Ticker</th>
              <th className="py-2 px-3 text-left">Source</th>
              <th className="py-2 px-3 text-right">Entry</th>
              <th className="py-2 px-3 text-right">Stop</th>
              <th className="py-2 px-3 text-right">Target</th>
              <th className="py-2 px-3 text-right">Qty</th>
              <th className="py-2 px-3 text-left">Opened</th>
            </tr>
          </thead>
          <tbody>
            {open.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-text-secondary text-sm">No open positions.</td></tr>}
            {open.map((t) => <OpenRow key={`${t.ticker}_${t.openedAt}`} t={t} />)}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-bold uppercase tracking-wider text-text-secondary mt-4">Recent closed (last 50)</h3>
      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <th className="py-2 px-3 text-left">Ticker</th>
              <th className="py-2 px-3 text-left">Source</th>
              <th className="py-2 px-3 text-right">Entry</th>
              <th className="py-2 px-3 text-right">Exit</th>
              <th className="py-2 px-3 text-right">Qty</th>
              <th className="py-2 px-3 text-right">P&amp;L</th>
              <th className="py-2 px-3 text-right">%</th>
              <th className="py-2 px-3 text-left">Reason</th>
              <th className="py-2 px-3 text-left">Closed</th>
            </tr>
          </thead>
          <tbody>
            {closed.length === 0 && <tr><td colSpan={9} className="py-6 text-center text-text-secondary text-sm">No closed trades yet.</td></tr>}
            {closed.map((t) => <ClosedRow key={`${t.ticker}_${t.closedAt}`} t={t} />)}
          </tbody>
        </table>
      </div>

      {stats && Object.keys(stats.bySource).length > 0 && (
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h4 className="text-xs uppercase tracking-wider text-text-secondary mb-2">By source</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Object.entries(stats.bySource).map(([src, s]) => (
              <div key={src} className="bg-bg-secondary rounded p-3">
                <div className="text-xs uppercase font-bold text-text-secondary">{src}</div>
                <div className={`text-lg font-bold ${pnlClass(s.pnl)}`}>
                  {s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}
                </div>
                <div className="text-xs text-text-secondary">
                  {s.count} trades · {s.wins}W ({Math.round((s.wins / s.count) * 100)}%)
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
