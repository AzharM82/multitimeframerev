import { useEffect, useMemo, useState } from "react";
import type { DayTradeAlertRow } from "../types.js";
import {
  getDayTradeAlerts,
  getDayTradePerformance,
  type DayTradeAlertsResponse,
  type DayTradePerformanceResponse,
  type PerfMode,
} from "../services/api.js";

const PAPER_NOTIONAL = 1000;
const TARGET_PCT = 3;   // +3% take-profit

type SortKey = "time" | "ticker" | "buy" | "sl" | "slPct" | "target" | "current" | "pnl" | "channel" | "date";

interface HeaderProps {
  label: string;
  sortKey?: SortKey;
  current: SortKey | null;
  dir: "asc" | "desc";
  align?: "left" | "right" | "center";
  onSort: (k: SortKey) => void;
}

function Th({ label, sortKey, current, dir, align = "left", onSort }: HeaderProps) {
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const isActive = sortKey === current;
  return (
    <th
      onClick={() => sortKey && onSort(sortKey)}
      className={`py-2 px-3 ${alignCls} ${sortKey ? "cursor-pointer hover:text-text-primary select-none" : ""}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive && <span className="text-accent">{dir === "asc" ? "▲" : "▼"}</span>}
      </span>
    </th>
  );
}

function ChannelBadge({ channel }: { channel: string }) {
  const isWa = channel === "QUEUED" || channel === "WHATSAPP";
  const cls = isWa
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return (
    <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded ${cls}`}>
      {isWa ? "WHATSAPP" : "PUSHOVER"}
    </span>
  );
}

function fmtMoney(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtSignedMoney(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

// ─── Performance panel: stat cards + daily P&L bar chart ──────────────────

function StatCard({ label, value, sub, tone = "neutral" }: {
  label: string; value: string; sub?: string; tone?: "neutral" | "bull" | "bear";
}) {
  const valueColor =
    tone === "bull" ? "text-signal-bull" :
    tone === "bear" ? "text-signal-bear" :
    "text-text-primary";
  return (
    <div className="bg-bg-card border border-border rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className={`text-xl font-bold tabular-nums mt-1 ${valueColor}`}>{value}</div>
      {sub && <div className="text-[11px] text-text-secondary mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}

function DailyPnlChart({ days }: { days: DayTradePerformanceResponse["days"] }) {
  if (days.length === 0) {
    return <div className="text-text-secondary text-sm py-8 text-center">No completed days yet.</div>;
  }
  const W = 800;
  const H = 220;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const barW = Math.max(8, Math.min(36, innerW / days.length - 4));
  const step = innerW / Math.max(1, days.length);
  const zeroY = padT + innerH / 2;
  const halfH = innerH / 2;

  function tickLabel(date: string): string {
    // "2026-05-15" → "5/15"
    const [, m, d] = date.split("-");
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* zero line */}
      <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="currentColor" className="text-border" strokeWidth="1" />
      {/* Y-axis ticks: +max, 0, -max */}
      <text x={padL - 6} y={padT + 10} textAnchor="end" className="fill-current text-text-secondary" fontSize="10">+${maxAbs.toFixed(0)}</text>
      <text x={padL - 6} y={zeroY + 3}   textAnchor="end" className="fill-current text-text-secondary" fontSize="10">0</text>
      <text x={padL - 6} y={H - padB + 2} textAnchor="end" className="fill-current text-text-secondary" fontSize="10">-${maxAbs.toFixed(0)}</text>

      {days.map((d, i) => {
        const cx = padL + step * i + step / 2;
        const h = (Math.abs(d.pnl) / maxAbs) * halfH;
        const y = d.pnl >= 0 ? zeroY - h : zeroY;
        const fill = d.pnl >= 0 ? "var(--color-signal-bull, #22c55e)" : "var(--color-signal-bear, #ef4444)";
        return (
          <g key={d.date}>
            <rect x={cx - barW / 2} y={y} width={barW} height={Math.max(1, h)} fill={fill} opacity={0.85}>
              <title>{`${d.date}: ${d.pnl >= 0 ? "+" : "-"}$${Math.abs(d.pnl).toFixed(2)} (${d.trades} trades, ${d.wins}W / ${d.losses}L)`}</title>
            </rect>
            <text
              x={cx}
              y={H - padB + 14}
              textAnchor="middle"
              className="fill-current text-text-secondary"
              fontSize="10"
            >
              {tickLabel(d.date)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ModeToggle({ mode, onChange }: { mode: PerfMode; onChange: (m: PerfMode) => void }) {
  const btn = (m: PerfMode, label: string, sub: string) => {
    const active = mode === m;
    return (
      <button
        onClick={() => onChange(m)}
        className={`px-3 py-1.5 text-xs font-bold border first:rounded-l last:rounded-r transition-colors ${
          active
            ? "bg-accent/15 text-accent border-accent/40"
            : "bg-bg-card text-text-secondary border-border hover:text-text-primary"
        }`}
        title={sub}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="inline-flex">
      {btn("tp_sl",   "TP +3% / SL",  "Exit at +3% target OR previous-2-bar-low SL OR EOD")}
      {btn("sl_only", "SL only",      "No TP. Trailing SL (prev 2-bar low) ratchets up; exit on SL hit or EOD")}
    </div>
  );
}

function PerformancePanel({ perf, mode, onModeChange }: {
  perf: DayTradePerformanceResponse | null;
  mode: PerfMode;
  onModeChange: (m: PerfMode) => void;
}) {
  if (!perf) {
    return (
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="text-sm text-text-secondary">Loading performance…</div>
      </div>
    );
  }
  const s = perf.stats;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[10px] uppercase tracking-widest text-text-secondary">Exit-rule simulator</div>
        <ModeToggle mode={mode} onChange={onModeChange} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          label="Total P&L"
          value={fmtSignedMoney(s.totalPnl)}
          sub={`${s.totalTrades} trades · ${s.daysCovered} days`}
          tone={s.totalPnl > 0 ? "bull" : s.totalPnl < 0 ? "bear" : "neutral"}
        />
        <StatCard
          label="Win Rate"
          value={`${(s.winRate * 100).toFixed(1)}%`}
          sub={`${s.wins}W / ${s.losses}L`}
        />
        <StatCard
          label="Avg / Trade"
          value={fmtSignedMoney(s.avgPerTrade)}
          tone={s.avgPerTrade > 0 ? "bull" : s.avgPerTrade < 0 ? "bear" : "neutral"}
        />
        <StatCard
          label="Best Day"
          value={s.bestDay ? fmtSignedMoney(s.bestDay.pnl) : "—"}
          sub={s.bestDay?.date}
          tone="bull"
        />
        <StatCard
          label="Worst Day"
          value={s.worstDay ? fmtSignedMoney(s.worstDay.pnl) : "—"}
          sub={s.worstDay?.date}
          tone="bear"
        />
      </div>
      <div className="bg-bg-card border border-border rounded-lg p-3">
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <div className="text-[10px] uppercase tracking-widest text-text-secondary">
            {mode === "sl_only"
              ? "Daily P&L · $1K paper trade · trailing 2-bar-low SL · no TP"
              : "Daily P&L · $1K paper trade · realized at TP / SL / EOD"}
          </div>
          <div className="text-[10px] text-text-secondary tabular-nums">
            Rules: skip first {perf.filters.firstSkipMin}m / last {perf.filters.lastSkipMin}m ·
            cap {perf.filters.maxPerDay}/day ·{" "}
            <span className="text-amber-300">{s.skippedFilter}</span> dropped (window),{" "}
            <span className="text-amber-300">{s.skippedCap}</span> dropped (cap)
          </div>
        </div>
        <DailyPnlChart days={perf.days} />
      </div>
    </div>
  );
}

// ─── Alert table row ───────────────────────────────────────────────────────

interface EnrichedAlert extends DayTradeAlertRow {
  _buy: number;
  _target: number;
  _pnl: number | null;
}

function enrich(a: DayTradeAlertRow): EnrichedAlert {
  const buy = a.reversalPrice;
  const target = buy * (1 + TARGET_PCT / 100);
  const pnl = (a.currentPrice !== undefined && a.currentPrice !== null)
    ? ((a.currentPrice - buy) / buy) * PAPER_NOTIONAL
    : null;
  return { ...a, _buy: buy, _target: target, _pnl: pnl };
}

function AlertRow({ alert }: { alert: EnrichedAlert }) {
  const pnlClass =
    alert._pnl === null
      ? "text-text-secondary"
      : alert._pnl > 0 ? "text-signal-bull"
      : alert._pnl < 0 ? "text-signal-bear"
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
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(alert._buy)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(alert.sl)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear">{fmtPct(alert.slPct)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(alert._target)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(alert.currentPrice)}</td>
      <td className={`py-2 px-3 text-right tabular-nums font-medium ${pnlClass}`}>
        {fmtSignedMoney(alert._pnl)}
      </td>
      <td className="py-2 px-3 text-center"><ChannelBadge channel={alert.status} /></td>
      <td className="py-2 px-3 text-xs text-text-secondary">{new Date(alert.firedAt).toLocaleDateString()}</td>
    </tr>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export function DayTradePage() {
  const [data, setData] = useState<DayTradeAlertsResponse | null>(null);
  const [perf, setPerf] = useState<DayTradePerformanceResponse | null>(null);
  const [perfMode, setPerfMode] = useState<PerfMode>("tp_sl");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>("time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function load(mode: PerfMode = perfMode) {
    setLoading(true);
    Promise.all([
      getDayTradeAlerts(100).catch((e: Error) => { setError(e.message); return null; }),
      getDayTradePerformance(mode).catch(() => null),
    ]).then(([alerts, p]) => {
      if (alerts) setData(alerts);
      if (p) setPerf(p);
    }).finally(() => setLoading(false));
  }

  function handleModeChange(m: PerfMode) {
    setPerfMode(m);
    setPerf(null);   // clear stale numbers while the new mode loads
    load(m);
  }

  useEffect(() => {
    load("tp_sl");
    // 5-min refresh — matches the TOS scanner's 5-min cycle. Anything
    // sooner is wasted work; new alerts can't appear between cycles.
    const id = setInterval(() => load(), 5 * 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enriched = useMemo<EnrichedAlert[]>(() => (data?.recent ?? []).map(enrich), [data]);

  const sorted = useMemo<EnrichedAlert[]>(() => {
    if (!sortKey) return enriched;
    const copy = [...enriched];
    copy.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sortKey) {
        case "ticker":  av = a.ticker; bv = b.ticker; break;
        case "buy":     av = a._buy; bv = b._buy; break;
        case "sl":      av = a.sl ?? -Infinity; bv = b.sl ?? -Infinity; break;
        case "slPct":   av = a.slPct ?? -Infinity; bv = b.slPct ?? -Infinity; break;
        case "target":  av = a._target; bv = b._target; break;
        case "current": av = a.currentPrice ?? -Infinity; bv = b.currentPrice ?? -Infinity; break;
        case "pnl":     av = a._pnl ?? -Infinity; bv = b._pnl ?? -Infinity; break;
        case "channel": av = a.status; bv = b.status; break;
        case "date":
        case "time":
        default:        av = a.firedAt; bv = b.firedAt; break;
      }
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [enriched, sortKey, sortDir]);

  function handleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      // strings default asc, numbers default desc
      const strKeys: SortKey[] = ["ticker", "channel", "time", "date"];
      setSortDir(strKeys.includes(k) ? "asc" : "desc");
    }
  }

  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">5-min Reversal · WhatsApp</div>
            <h2 className="text-xl font-bold mt-1">Day Trade Alerts</h2>
          </div>
          <div className="text-xs text-text-secondary">
            Local Finviz scanner reads Azhar_Reversal off TOS via OCR every 5 min, 6:30 AM–1:00 PM PT ·{" "}
            <span className="text-text-primary">{total}</span> alerts logged
          </div>
        </div>
      </div>

      <PerformancePanel perf={perf} mode={perfMode} onModeChange={handleModeChange} />

      {error && <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">{error}</div>}

      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <Th label="Time"    sortKey="time"    current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Ticker"  sortKey="ticker"  current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Buy"     sortKey="buy"     current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="SL"      sortKey="sl"      current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="%SL"     sortKey="slPct"   current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Target (+3%)" sortKey="target" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Current" sortKey="current" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="$1K P&L" sortKey="pnl"     current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Channel" sortKey="channel" current={sortKey} dir={sortDir} onSort={handleSort} align="center" />
              <Th label="Date"    sortKey="date"    current={sortKey} dir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={10} className="py-8 text-center text-text-secondary text-sm">
                No alerts yet today. The next scan runs in ≤5 min during market hours.
              </td></tr>
            )}
            {!loading && sorted.map((a) => <AlertRow key={a.rowKey} alert={a} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
