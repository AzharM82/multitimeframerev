import { useEffect, useState } from "react";
import type { DayTradeAlertRow } from "../types.js";
import { getDayTradeAlerts, type DayTradeAlertsResponse } from "../services/api.js";

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

const PAPER_NOTIONAL = 1000;
const TARGET_PCT = 3;

function fmtMoney(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtSignedMoney(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function AlertRow({ alert }: { alert: DayTradeAlertRow }) {
  const buy = alert.reversalPrice;
  const target = buy * (1 + TARGET_PCT / 100);
  const current = alert.currentPrice;
  // $1000 paper trade: notional / buy = shares; P&L = (current - buy) * shares.
  const paperPnL = current !== undefined ? ((current - buy) / buy) * PAPER_NOTIONAL : undefined;
  const pnlClass =
    paperPnL === undefined
      ? "text-text-secondary"
      : paperPnL > 0
      ? "text-signal-bull"
      : paperPnL < 0
      ? "text-signal-bear"
      : "text-text-secondary";

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
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(buy)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(alert.sl)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear">{fmtPct(alert.slPct)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(target)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(current)}</td>
      <td className={`py-2 px-3 text-right tabular-nums font-medium ${pnlClass}`}>
        {fmtSignedMoney(paperPnL)}
      </td>
      <td className="py-2 px-3 text-center"><ChannelBadge channel={alert.status} /></td>
      <td className="py-2 px-3 text-xs text-text-secondary">{new Date(alert.firedAt).toLocaleDateString()}</td>
    </tr>
  );
}

export function DayTradePage() {
  const [data, setData] = useState<DayTradeAlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    getDayTradeAlerts(100)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const alerts = data?.recent ?? [];
  const total = data?.total ?? 0;

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
              <th className="py-2 px-3 text-right">Buy</th>
              <th className="py-2 px-3 text-right">SL</th>
              <th className="py-2 px-3 text-right">%SL</th>
              <th className="py-2 px-3 text-right" title="Target = Buy × 1.03. Profit on $1000 if hit = $30.">Target (+3%)</th>
              <th className="py-2 px-3 text-right">Current</th>
              <th className="py-2 px-3 text-right" title="$1000 paper trade. P&L = (current − buy) / buy × $1000.">$1K P&L</th>
              <th className="py-2 px-3 text-center">Channel</th>
              <th className="py-2 px-3 text-left">Date</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>}
            {!loading && alerts.length === 0 && (
              <tr><td colSpan={10} className="py-8 text-center text-text-secondary text-sm">
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
