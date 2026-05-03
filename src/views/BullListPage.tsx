import { useEffect, useMemo, useState } from "react";
import type { BullListResponse, BullListRow, BullStatus } from "../types.js";
import { getBullList, deleteBullEntry } from "../services/api.js";

const STATUS_COLORS: Record<BullStatus, string> = {
  OPEN: "bg-accent/15 text-accent border-accent/40",
  TP_HIT: "bg-signal-bull/15 text-signal-bull border-signal-bull/40",
  SL_HIT: "bg-signal-bear/15 text-signal-bear border-signal-bear/40",
  EXPIRED: "bg-slate-500/15 text-slate-400 border-slate-500/40",
};

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
  _slPct: number; // (entry - sl) / entry * 100
}

function enrich(r: BullListRow): EnrichedRow {
  const slPct = r.entry > 0 ? ((r.entry - r.sl) / r.entry) * 100 : 0;
  return { ...r, _slPct: Math.round(slPct * 100) / 100 };
}

function pnlClass(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "text-text-secondary";
  if (pct > 0) return "text-signal-bull";
  if (pct < 0) return "text-signal-bear";
  return "text-text-secondary";
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
      <td className="py-2 px-3 text-right tabular-nums text-emerald-300/80">${row.entry.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear/80">${row.sl.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{row._slPct.toFixed(2)}%</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bull/80">${row.tp.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs text-text-secondary">{row.rPct.toFixed(2)}</td>
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

  const sorted = useMemo<EnrichedRow[]>(() => {
    if (!sortKey) return enriched;
    const copy = [...enriched];
    copy.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sortKey) {
        case "ticker": av = a.ticker; bv = b.ticker; break;
        case "entry": av = a.entry; bv = b.entry; break;
        case "sl": av = a.sl; bv = b.sl; break;
        case "slPct": av = a._slPct; bv = b._slPct; break;
        case "tp": av = a.tp; bv = b.tp; break;
        case "rPct": av = a.rPct; bv = b.rPct; break;
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
            <h2 className="text-xl font-bold mt-1">Bull List</h2>
          </div>
          <div className="text-xs text-text-secondary">
            Auto-ingested from <code className="text-accent">tosbullalert@gmail.com</code> hourly.
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
              <Th label="Ticker"  sortKey="ticker"  current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Entry"   sortKey="entry"   current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Stop"    sortKey="sl"      current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="%SL"     sortKey="slPct"   current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Target"  sortKey="tp"      current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="R"       sortKey="rPct"    current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Last"    sortKey="last"    current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="P&L"     sortKey="pnlPct"  current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Status"  sortKey="status"  current={sortKey} dir={sortDir} onSort={handleSort} align="center" />
              <Th label="Added"   sortKey="addedAt" current={sortKey} dir={sortDir} onSort={handleSort} />
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

      <div className="text-[11px] text-text-secondary px-1">
        <span className="text-text-primary">%SL</span> = (entry − stop) / entry · risk size per share.
        &nbsp;·&nbsp; <span className="text-text-primary">R</span> = (target − entry) / (entry − stop) · reward-to-risk multiple.
        &nbsp;·&nbsp; Click any column header to sort.
      </div>
    </div>
  );
}
