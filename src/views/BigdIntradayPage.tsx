import { useEffect, useState } from "react";
import { getBigdogAlerts } from "../services/api.js";
import type { BigdogAlertHit, BigdogAlertsResponse, BigdogParts } from "../types.js";

const PART_KEYS: { key: keyof BigdogParts; label: string }[] = [
  { key: "rev", label: "Rev" },
  { key: "atr", label: "ATR" },
  { key: "vwap", label: "VWAP" },
  { key: "vol", label: "Vol" },
  { key: "tick", label: "TICK" },
  { key: "stoch", label: "Stoch" },
];

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles",
    });
  } catch {
    return iso;
  }
}

function Part({ v }: { v: number }) {
  if (v > 0) return <span className="text-signal-bull">+</span>;
  if (v < 0) return <span className="text-signal-bear">&minus;</span>;
  return <span className="text-dim">·</span>;
}

export function BigdIntradayPage() {
  const [data, setData] = useState<BigdogAlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBigdogAlerts(date)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const hits: BigdogAlertHit[] = data?.hits ?? [];
  const longs = hits.filter((h) => h.direction === "LONG").length;
  const shorts = hits.length - longs;

  return (
    <div className="max-w-6xl mx-auto space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-text-primary">BIGD-Intraday</h2>
          <p className="text-xs text-text-secondary">
            5-min OCR signed score (&minus;6&hellip;+6): Reversal + ATR + VWAP + Buy% + TICK-breadth + Stoch.
            Bull alerts &ge;&nbsp;+3, bear &le;&nbsp;&minus;3.
          </p>
        </div>
        {data?.available && data.available.length > 0 && (
          <select
            className="bg-bg-card border border-border rounded px-2 py-1 text-xs text-text-primary"
            value={date ?? data.date ?? ""}
            onChange={(e) => setDate(e.target.value || undefined)}
          >
            {data.available.map((a) => (
              <option key={a.date} value={a.date}>{a.date} ({a.totalHits})</option>
            ))}
          </select>
        )}
      </div>

      {/* Summary */}
      <div className="flex gap-3 text-xs">
        <div className="bg-bg-card border border-border rounded px-3 py-1.5">
          <span className="text-text-secondary">Date </span>
          <span className="text-text-primary font-semibold tabular-nums">{data?.date ?? "—"}</span>
        </div>
        <div className="bg-bg-card border border-border rounded px-3 py-1.5">
          <span className="text-text-secondary">Alerts </span>
          <span className="text-text-primary font-semibold tabular-nums">{hits.length}</span>
        </div>
        <div className="bg-bg-card border border-border rounded px-3 py-1.5">
          <span className="text-signal-bull font-semibold tabular-nums">{longs}</span>
          <span className="text-text-secondary"> long / </span>
          <span className="text-signal-bear font-semibold tabular-nums">{shorts}</span>
          <span className="text-text-secondary"> short</span>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-text-secondary text-sm">Loading&hellip;</div>
      ) : hits.length === 0 ? (
        <div className="py-12 text-center text-text-secondary text-sm">
          No alerts logged{data?.date ? ` for ${data.date}` : ""} yet.
        </div>
      ) : (
        <div className="bg-bg-card border border-border rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="py-1.5 px-3 text-left">Time</th>
                <th className="py-1.5 px-3 text-left">Ticker</th>
                <th className="py-1.5 px-3 text-left">Dir</th>
                <th className="py-1.5 px-3 text-right">Score</th>
                {PART_KEYS.map((c) => (
                  <th key={c.key} className="py-1.5 px-2 text-center">{c.label}</th>
                ))}
                <th className="py-1.5 px-3 text-left">REV</th>
                <th className="py-1.5 px-3 text-right">Buy%</th>
                <th className="py-1.5 px-3 text-right">TICK bal</th>
                <th className="py-1.5 px-3 text-right">Stoch K/D</th>
                <th className="py-1.5 px-2 text-center">VWAP</th>
                <th className="py-1.5 px-2 text-center">ATR</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h, i) => {
                const isLong = h.direction === "LONG";
                const dirColor = isLong ? "text-signal-bull" : "text-signal-bear";
                const scoreColor = h.score > 0 ? "text-signal-bull" : h.score < 0 ? "text-signal-bear" : "text-text-secondary";
                return (
                  <tr key={`${h.ticker}-${h.firedAt}-${i}`} className="border-b border-border hover:bg-bg-secondary/40">
                    <td className="py-1.5 px-3 tabular-nums text-text-secondary">{fmtTime(h.firedAt)}</td>
                    <td className="py-1.5 px-3 font-semibold text-text-primary">
                      {h.ticker}
                      {h.scoreMismatch && <span className="ml-1 text-[10px] text-signal-bear" title="on-chart vs recomputed score differ">≠</span>}
                    </td>
                    <td className={`py-1.5 px-3 font-semibold ${dirColor}`}>{h.direction}</td>
                    <td className={`py-1.5 px-3 text-right font-bold tabular-nums ${scoreColor}`}>
                      {h.score > 0 ? `+${h.score}` : h.score}
                    </td>
                    {PART_KEYS.map((c) => (
                      <td key={c.key} className="py-1.5 px-2 text-center"><Part v={h.parts[c.key]} /></td>
                    ))}
                    <td className="py-1.5 px-3 tabular-nums text-text-secondary">
                      {h.rvDir ?? "—"}{h.rvBars != null ? ` ${h.rvBars}b` : ""}
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{h.buyPct ?? "—"}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{h.tickBal ?? "—"}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">
                      {h.stochK != null && h.stochD != null ? `${h.stochK}/${h.stochD}` : "—"}
                    </td>
                    <td className={`py-1.5 px-2 text-center ${h.vwapSide === "A" ? "text-signal-bull" : "text-signal-bear"}`}>{h.vwapSide ?? "—"}</td>
                    <td className={`py-1.5 px-2 text-center ${h.atrSide === "A" ? "text-signal-bull" : "text-signal-bear"}`}>{h.atrSide ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
