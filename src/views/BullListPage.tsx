import { useEffect, useMemo, useState } from "react";
import type { BullListResponse, BullListRow, BullStatus } from "../types.js";
import { getBullList, deleteBullEntry } from "../services/api.js";

const STATUS_COLORS: Record<BullStatus, string> = {
  PENDING: "bg-amber-500/15 text-amber-700 border-amber-500/40",
  OPEN: "bg-accent/15 text-accent border-accent/40",
  TP_HIT: "bg-signal-bull/15 text-signal-bull border-signal-bull/40",
  SL_HIT: "bg-signal-bear/15 text-signal-bear border-signal-bear/40",
  EXPIRED: "bg-slate-500/15 text-slate-600 border-slate-500/40",
  CANCELLED: "bg-slate-500/15 text-slate-600 border-slate-500/40",
};

const PENDING_EXPIRY_DAYS = 3;

// Trading days elapsed since an ISO timestamp (mirrors the API's counter).
function tradingDaysSince(iso: string): number {
  const cur = new Date(iso);
  const now = new Date();
  let count = 0;
  while (cur < now) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

type SortKey =
  | "ticker"
  | "entry"
  | "sl"
  | "slPct"
  | "tp"
  | "rPct"
  | "last"
  | "pnlPct"
  | "status"
  | "addedAt";

interface EnrichedRow extends BullListRow {
  _slPct: number | null; // (entry - sl) / entry * 100
}

function enrich(r: BullListRow): EnrichedRow {
  const slPct = r.entry !== undefined && r.entry > 0 && r.sl !== undefined
    ? ((r.entry - r.sl) / r.entry) * 100
    : null;
  return { ...r, _slPct: slPct !== null ? Math.round(slPct * 100) / 100 : null };
}

// Explicit Pacific timestamp — "Jun 6, 4:30 AM PDT". The PDT/PST label comes
// from the timezone engine (not a hardcoded suffix), so it's always correct
// across daylight-saving changes. NOTE: TOS legitimately fires D-Bull-Sig
// emails premarket (~3:30-4:30 AM PT) and overnight as its scan refreshes —
// early-morning stamps here are real, not a timezone bug.
function fmtPacific(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function pnlClass(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "text-text-secondary";
  if (pct > 0) return "text-signal-bull";
  if (pct < 0) return "text-signal-bear";
  return "text-text-secondary";
}

// ─── Closed-trades stats strip ($5k notional per trade, mirrors /api/paper-trades) ───

const NOTIONAL_PER_TRADE = 5000;

interface ClosedStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  bestPct: number;
  worstPct: number;
}

function computeClosedStats(rows: BullListRow[]): ClosedStats | null {
  const done = rows.filter((r) => r.exitPrice !== undefined && r.exitPrice !== null && r.entry !== undefined && r.entry > 0);
  if (done.length === 0) return null;
  let wins = 0;
  let totalPnl = 0;
  let bestPct = -Infinity;
  let worstPct = Infinity;
  for (const r of done) {
    const exit = r.exitPrice as number;
    const entry = r.entry as number;
    const qty = Math.floor(NOTIONAL_PER_TRADE / entry);
    const pnl = (exit - entry) * qty;
    const pct = ((exit - entry) / entry) * 100;
    if (pnl > 0) wins++;
    totalPnl += pnl;
    if (pct > bestPct) bestPct = pct;
    if (pct < worstPct) worstPct = pct;
  }
  return {
    trades: done.length,
    wins,
    losses: done.length - wins,
    winRate: (wins / done.length) * 100,
    totalPnl,
    avgPnl: totalPnl / done.length,
    bestPct,
    worstPct,
  };
}

function fmtUsd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bull" | "bear" }) {
  const toneCls = tone === "bull" ? "text-signal-bull" : tone === "bear" ? "text-signal-bear" : "text-text-primary";
  return (
    <div className="bg-bg-card border border-border rounded-lg p-3 flex-1 min-w-[140px]">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className={`text-lg font-bold tabular-nums mt-1 ${toneCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-text-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

function ClosedStatsStrip({ stats }: { stats: ClosedStats }) {
  return (
    <div className="flex flex-wrap gap-3">
      <StatCard
        label="Total P&L"
        value={fmtUsd(stats.totalPnl)}
        sub={`${stats.trades} trades · $5k notional each`}
        tone={stats.totalPnl >= 0 ? "bull" : "bear"}
      />
      <StatCard
        label="Win Rate"
        value={`${stats.winRate.toFixed(1)}%`}
        sub={`${stats.wins}W / ${stats.losses}L`}
        tone={stats.winRate >= 50 ? "bull" : "bear"}
      />
      <StatCard
        label="Avg / Trade"
        value={fmtUsd(stats.avgPnl)}
        tone={stats.avgPnl >= 0 ? "bull" : "bear"}
      />
      <StatCard label="Best" value={`+${stats.bestPct.toFixed(2)}%`} tone="bull" />
      <StatCard label="Worst" value={`${stats.worstPct.toFixed(2)}%`} tone="bear" />
    </div>
  );
}

interface ThProps {
  label: string;
  sortKey?: SortKey;
  current: SortKey | null;
  dir: "asc" | "desc";
  align?: "left" | "right" | "center";
  onSort: (k: SortKey) => void;
}

function Th({ label, sortKey, current, dir, align = "left", onSort }: ThProps) {
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

function num(v: number | null | undefined, prefix = "$", suffix = ""): string {
  return v !== undefined && v !== null ? `${prefix}${v.toFixed(2)}${suffix}` : "—";
}

function Row({ row, onRemove }: { row: EnrichedRow; onRemove: () => void }) {
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
      <td className="py-2 px-3 text-right tabular-nums text-emerald-700/90">{num(row.entry)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear/80">{num(row.sl)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{num(row._slPct, "", "%")}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bull/80">{num(row.tp)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs text-text-secondary">{num(row.rPct, "")}</td>
      <td className="py-2 px-3 text-right tabular-nums">
        {row.last !== undefined && row.last !== null && row.last > 0 ? `$${row.last.toFixed(2)}` : "—"}
      </td>
      <td className={`py-2 px-3 text-right tabular-nums font-semibold ${pnlClass(row.pnlPct)}`}>
        {row.pnlPct !== undefined && row.pnlPct !== null ? `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%` : "—"}
      </td>
      <td className="py-2 px-3 text-center">
        <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded ${STATUS_COLORS[row.status]}`}>
          {row.status}
        </span>
      </td>
      <td className="py-2 px-3 text-xs text-text-secondary">{fmtPacific(row.confirmedAt ?? row.addedAt)}</td>
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

// ─── Pending signals table (daily signal waiting for 30m confirmation) ─────

function PendingTable({ rows, onRemove }: { rows: BullListRow[]; onRemove: (r: BullListRow) => void }) {
  return (
    <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
          <tr>
            <th className="py-2 px-3 text-left">Ticker</th>
            <th className="py-2 px-3 text-left">Daily Signal Bar</th>
            <th className="py-2 px-3 text-left">Signal Received</th>
            <th className="py-2 px-3 text-center">Waiting For</th>
            <th className="py-2 px-3 text-right">Days Left</th>
            <th className="py-2 px-3 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={6} className="py-8 text-center text-text-secondary text-sm">
              No pending signals. New D-Bull-Sig emails land here until a 30-min reversal confirms.
            </td></tr>
          )}
          {rows.map((r) => {
            const daysLeft = Math.max(0, PENDING_EXPIRY_DAYS - tradingDaysSince(r.addedAt));
            return (
              <tr key={r.rowKey} className="border-b border-border hover:bg-bg-secondary/40">
                <td className="py-2 px-3">
                  <a
                    href={`https://www.tradingview.com/chart/?symbol=${r.ticker}`}
                    target="_blank"
                    rel="noopener"
                    className="font-bold text-accent hover:underline"
                  >
                    {r.ticker}
                  </a>
                </td>
                <td className="py-2 px-3 text-xs text-text-secondary">{r.signalBarTs ? r.signalBarTs.slice(0, 10) : "—"}</td>
                <td className="py-2 px-3 text-xs text-text-secondary">{fmtPacific(r.addedAt)}</td>
                <td className="py-2 px-3 text-center">
                  <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded bg-amber-500/15 text-amber-700 border-amber-500/40">
                    30M REVERSAL
                  </span>
                </td>
                <td className={`py-2 px-3 text-right tabular-nums font-semibold ${daysLeft <= 1 ? "text-signal-bear" : "text-text-primary"}`}>
                  {daysLeft}
                </td>
                <td className="py-2 px-3 text-right">
                  <button
                    onClick={() => onRemove(r)}
                    className="text-xs text-text-secondary hover:text-signal-bear"
                    title="Remove"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BullListPage() {
  const [tab, setTab] = useState<"pending" | "open" | "closed">("open");
  const [data, setData] = useState<BullListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>("addedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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

  const enriched = useMemo<EnrichedRow[]>(() => (data?.rows ?? []).map(enrich), [data]);

  const closedStats = useMemo<ClosedStats | null>(
    () => (tab === "closed" && data ? computeClosedStats(data.rows) : null),
    [tab, data],
  );

  const sorted = useMemo<EnrichedRow[]>(() => {
    if (!sortKey) return enriched;
    const copy = [...enriched];
    copy.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sortKey) {
        case "ticker": av = a.ticker; bv = b.ticker; break;
        case "entry": av = a.entry ?? -1; bv = b.entry ?? -1; break;
        case "sl": av = a.sl ?? -1; bv = b.sl ?? -1; break;
        case "slPct": av = a._slPct ?? -1; bv = b._slPct ?? -1; break;
        case "tp": av = a.tp ?? -1; bv = b.tp ?? -1; break;
        case "rPct": av = a.rPct ?? -1; bv = b.rPct ?? -1; break;
        case "last": av = a.last ?? -1; bv = b.last ?? -1; break;
        case "pnlPct": av = a.pnlPct ?? -9999; bv = b.pnlPct ?? -9999; break;
        case "status": av = a.status; bv = b.status; break;
        case "addedAt":
        default: av = a.addedAt; bv = b.addedAt; break;
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
      setSortDir(k === "ticker" || k === "status" ? "asc" : "desc");
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">TOS · D-Bull-Sig</div>
            <h2 className="text-xl font-bold mt-1">Swing List</h2>
          </div>
          <div className="text-xs text-text-secondary">
            Daily signal from <code className="text-accent">tosbullalert@gmail.com</code> →
            waits up to {PENDING_EXPIRY_DAYS} trading days for a fresh <span className="text-text-primary">30-min reversal</span> during
            market hours → entry at live price · SL = 30m swing low · TP +5%
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(["pending", "open", "closed"] as const).map((t) => (
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

      {closedStats && <ClosedStatsStrip stats={closedStats} />}

      {tab === "pending" && !loading && (
        <PendingTable rows={data?.rows ?? []} onRemove={handleRemove} />
      )}
      {tab === "pending" && loading && (
        <div className="bg-bg-card border border-border rounded-lg p-8 text-center text-text-secondary text-sm">Loading…</div>
      )}

      {tab !== "pending" && (
      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <Th label="Ticker"  sortKey="ticker"  current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Entry"   sortKey="entry"   current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Stop"    sortKey="sl"      current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="%SL"     sortKey="slPct"   current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Target"  sortKey="tp"      current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="R"       sortKey="rPct"    current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Last"    sortKey="last"    current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="P&L"     sortKey="pnlPct"  current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Status"  sortKey="status"  current={sortKey} dir={sortDir} onSort={handleSort} align="center" />
              <Th label="Entered" sortKey="addedAt" current={sortKey} dir={sortDir} onSort={handleSort} />
              <th className="py-2 px-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={11} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={11} className="py-8 text-center text-text-secondary text-sm">
                No {tab} positions.
              </td></tr>
            )}
            {!loading && sorted.map((r) => <Row key={r.rowKey} row={r} onRemove={() => handleRemove(r)} />)}
          </tbody>
        </table>
      </div>
      )}

      <div className="text-[11px] text-text-secondary px-1">
        <span className="text-text-primary">Execution model:</span> daily D-Bull-Sig signal → PENDING until a fresh 30-min U1 prints
        during market hours (max {PENDING_EXPIRY_DAYS} trading days, else CANCELLED) → entry at the live price at confirmation.
        &nbsp;·&nbsp; <span className="text-text-primary">%SL</span> = (entry − stop) / entry.
        &nbsp;·&nbsp; <span className="text-text-primary">R</span> = (target − entry) / (entry − stop).
        &nbsp;·&nbsp; Click any column header to sort.
      </div>
    </div>
  );
}
