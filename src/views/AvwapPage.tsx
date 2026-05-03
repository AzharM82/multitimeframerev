import { useEffect, useMemo, useState } from "react";
import type { AvwapHit, AvwapResultsResponse } from "../types.js";
import { getAvwapResults } from "../services/api.js";

const PATTERN_COLORS: Record<string, string> = {
  PULLBACK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  PINCH: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RECLAIM: "bg-sky-500/15 text-sky-300 border-sky-500/40",
};

type SortKey = "score" | "ticker" | "pattern" | "price" | "buy" | "sl" | "slPct" | "bandPct" | "volumeMultiple";

interface EnrichedHit extends AvwapHit {
  // For old payloads without buy/sl, derive from min of involved AVWAPs
  _buy: number;
  _sl: number;
  _slPct: number;
}

function enrich(hit: AvwapHit): EnrichedHit {
  if (typeof hit.buy === "number" && typeof hit.sl === "number" && typeof hit.slPct === "number") {
    return { ...hit, _buy: hit.buy, _sl: hit.sl, _slPct: hit.slPct };
  }
  // Fallback: compute from details.avwapValues filtered by involvedAnchors
  const involvedVals = hit.involvedAnchors
    .map((a) => hit.details.avwapValues[a])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const sl = involvedVals.length > 0 ? Math.min(...involvedVals) : hit.price;
  const slPct = hit.price > 0 ? ((hit.price - sl) / hit.price) * 100 : 0;
  return {
    ...hit,
    _buy: hit.price,
    _sl: Math.round(sl * 100) / 100,
    _slPct: Math.round(slPct * 100) / 100,
  };
}

function ScoreBar({ score }: { score: number }) {
  const w = Math.max(2, Math.min(100, score));
  const color = score >= 70 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-slate-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-bg-card rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums">{score}</span>
    </div>
  );
}

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

function HitRow({ hit, idx }: { hit: EnrichedHit; idx: number }) {
  return (
    <tr className="border-b border-border hover:bg-bg-secondary/40">
      <td className="py-2 px-3 text-xs text-text-secondary tabular-nums">{idx + 1}</td>
      <td className="py-2 px-3">
        <a
          href={`https://www.tradingview.com/chart/?symbol=${hit.ticker}`}
          target="_blank"
          rel="noopener"
          className="font-bold text-accent hover:underline"
        >
          {hit.ticker}
        </a>
      </td>
      <td className="py-2 px-3">
        <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded ${PATTERN_COLORS[hit.pattern] ?? ""}`}>
          {hit.pattern}
        </span>
      </td>
      <td className="py-2 px-3"><ScoreBar score={hit.score} /></td>
      <td className="py-2 px-3 text-right tabular-nums">${hit.price.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-emerald-300/80">${hit._buy.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-signal-bear/80">${hit._sl.toFixed(2)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{hit._slPct.toFixed(2)}%</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{hit.bandPct.toFixed(2)}%</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{hit.volumeMultiple.toFixed(2)}×</td>
      <td className="py-2 px-3 text-center">
        {hit.trendAligned ? (
          <span className="px-1.5 py-0.5 text-[10px] font-bold bg-signal-bull/20 text-signal-bull rounded">UP</span>
        ) : (
          <span className="text-text-secondary text-xs">—</span>
        )}
      </td>
      <td className="py-2 px-3 text-xs text-text-secondary">{hit.involvedAnchors.join(" · ")}</td>
    </tr>
  );
}

export function AvwapPage() {
  const [data, setData] = useState<AvwapResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAvwapResults()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const enriched = useMemo<EnrichedHit[]>(() => (data?.hits ?? []).map(enrich), [data]);

  const sorted = useMemo<EnrichedHit[]>(() => {
    if (!sortKey) return enriched;
    const copy = [...enriched];
    copy.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sortKey) {
        case "ticker": av = a.ticker; bv = b.ticker; break;
        case "pattern": av = a.pattern; bv = b.pattern; break;
        case "price": av = a.price; bv = b.price; break;
        case "buy": av = a._buy; bv = b._buy; break;
        case "sl": av = a._sl; bv = b._sl; break;
        case "slPct": av = a._slPct; bv = b._slPct; break;
        case "bandPct": av = a.bandPct; bv = b.bandPct; break;
        case "volumeMultiple": av = a.volumeMultiple; bv = b.volumeMultiple; break;
        case "score":
        default: av = a.score; bv = b.score; break;
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
      setSortDir(k === "ticker" || k === "pattern" ? "asc" : "desc");
    }
  }

  const counts = enriched.reduce<Record<string, number>>((acc, h) => {
    acc[h.pattern] = (acc[h.pattern] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">Brian Shannon · Anchored VWAP</div>
            <h2 className="text-xl font-bold mt-1">Swing Setups</h2>
          </div>
          <div className="text-xs text-text-secondary">
            {data?.date ? `As of ${data.date}` : "—"} ·{" "}
            <span className="text-text-primary">{enriched.length}</span> hits ·{" "}
            <span className="text-emerald-300">Pullback {counts.PULLBACK ?? 0}</span> ·{" "}
            <span className="text-amber-300">Pinch {counts.PINCH ?? 0}</span> ·{" "}
            <span className="text-sky-300">Reclaim {counts.RECLAIM ?? 0}</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">{error}</div>
      )}

      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              <th className="py-2 px-3 text-left">#</th>
              <Th label="Ticker"  sortKey="ticker"         current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Pattern" sortKey="pattern"        current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Score"   sortKey="score"          current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Price"   sortKey="price"          current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Buy"     sortKey="buy"            current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="SL"      sortKey="sl"             current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="%SL"     sortKey="slPct"          current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Band"    sortKey="bandPct"        current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <Th label="Vol"     sortKey="volumeMultiple" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <th className="py-2 px-3 text-center">Trend</th>
              <th className="py-2 px-3 text-left">Anchors</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={12} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={12} className="py-8 text-center text-text-secondary text-sm">
                No setups yet. The first scan runs at 4:15 PM ET.
              </td></tr>
            )}
            {!loading && sorted.map((h, i) => <HitRow key={`${h.ticker}_${h.pattern}`} hit={h} idx={i} />)}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-text-secondary px-1">
        Anchors: ATH · 52W High · 52W Low · YTD · Swing Low. Earnings anchors deferred for v1.
        &nbsp;·&nbsp; <span className="text-text-primary">SL</span> = lowest involved AVWAP (natural support floor).
        &nbsp;·&nbsp; <span className="text-text-primary">%SL</span> = how far below price the stop sits.
        &nbsp;·&nbsp; Click any column header to sort.
      </div>
    </div>
  );
}
