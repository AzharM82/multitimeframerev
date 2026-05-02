import { useEffect, useState } from "react";
import type { PaperTradesResponse, DayTradeAlertRow } from "../types.js";
import { getPaperTrades } from "../services/api.js";

function ChannelBadge({ channel }: { channel: string }) {
  const isWa = channel === "QUEUED";
  const cls = isWa
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return (
    <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded ${cls}`}>
      {isWa ? "WHATSAPP" : "PUSHOVER"}
    </span>
  );
}

function AlertRow({ alert }: { alert: DayTradeAlertRow }) {
  return (
    <tr className="border-b border-border hover:bg-bg-secondary/40">
      <td className="py-2 px-3 text-xs text-text-secondary tabular-nums">
        {new Date(alert.firedAt).toLocaleTimeString()}
      </td>
      <td className="py-2 px-3">
        <a
          href={`https://www.tradingview.com/chart/?symbol=${alert.ticker}`}
          target="_blank"
          rel="noopener"
          className="font-bold text-accent hover:underline"
        >
          {alert.ticker}
        </a>
      </td>
      <td className="py-2 px-3 text-right tabular-nums">${alert.reversalPrice.toFixed(2)}</td>
      <td className="py-2 px-3 text-center"><ChannelBadge channel={alert.status} /></td>
      <td className="py-2 px-3 text-xs text-text-secondary">{new Date(alert.firedAt).toLocaleDateString()}</td>
    </tr>
  );
}

export function DayTradePage() {
  const [data, setData] = useState<PaperTradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    getPaperTrades()
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const alerts = data?.dayTradeAlerts.recent ?? [];
  const total = data?.dayTradeAlerts.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">10-min Reversal · WhatsApp</div>
            <h2 className="text-xl font-bold mt-1">Day Trade Alerts</h2>
          </div>
          <div className="text-xs text-text-secondary">
            Scans union of AVWAP top-30 + open Bull List every 10 min, 9:30–15:30 ET ·{" "}
            <span className="text-text-primary">{total}</span> alerts logged
          </div>
        </div>
      </div>

      {error && <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">{error}</div>}

      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <th className="py-2 px-3 text-left">Time</th>
              <th className="py-2 px-3 text-left">Ticker</th>
              <th className="py-2 px-3 text-right">Reversal Price</th>
              <th className="py-2 px-3 text-center">Channel</th>
              <th className="py-2 px-3 text-left">Date</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>}
            {!loading && alerts.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center text-text-secondary text-sm">
                No alerts yet today. The next scan runs in ≤10 min during market hours.
              </td></tr>
            )}
            {!loading && alerts.map((a) => <AlertRow key={a.rowKey} alert={a} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
