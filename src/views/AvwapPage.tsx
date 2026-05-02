import { useEffect, useState } from "react";
import type { AvwapHit, AvwapResultsResponse } from "../types.js";
import { getAvwapResults } from "../services/api.js";

const PATTERN_COLORS: Record<string, string> = {
  PULLBACK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  PINCH: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RECLAIM: "bg-sky-500/15 text-sky-300 border-sky-500/40",
};

function ScoreBar({ score }: { score: number }) {
  const w = Math.max(2, Math.min(100, score));
  const color = score >= 70 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-slate-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-bg-card rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums">{score}</span>
    </div>
  );
}

function HitRow({ hit, idx }: { hit: AvwapHit; idx: number }) {
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
      <td className="py-2 px-3 text-xs text-text-secondary">{hit.involvedAnchors.join(" · ")}</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{hit.bandPct.toFixed(2)}%</td>
      <td className="py-2 px-3 text-right tabular-nums text-xs">{hit.volumeMultiple.toFixed(2)}×</td>
      <td className="py-2 px-3 text-center">
        {hit.trendAligned ? (
          <span className="px-1.5 py-0.5 text-[10px] font-bold bg-signal-bull/20 text-signal-bull rounded">UP</span>
        ) : (
          <span className="text-text-secondary text-xs">—</span>
        )}
      </td>
    </tr>
  );
}

export function AvwapPage() {
  const [data, setData] = useState<AvwapResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAvwapResults()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const hits = data?.hits ?? [];
  const counts = hits.reduce<Record<string, number>>((acc, h) => {
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
            <span className="text-text-primary">{hits.length}</span> hits ·{" "}
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
              <th className="py-2 px-3 text-left">Ticker</th>
              <th className="py-2 px-3 text-left">Pattern</th>
              <th className="py-2 px-3 text-left">Score</th>
              <th className="py-2 px-3 text-right">Price</th>
              <th className="py-2 px-3 text-left">Anchors</th>
              <th className="py-2 px-3 text-right">Band</th>
              <th className="py-2 px-3 text-right">Vol</th>
              <th className="py-2 px-3 text-center">Trend</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="py-8 text-center text-text-secondary text-sm">Loading…</td></tr>
            )}
            {!loading && hits.length === 0 && (
              <tr><td colSpan={9} className="py-8 text-center text-text-secondary text-sm">
                No setups yet. The first scan runs at 4:15 PM ET.
              </td></tr>
            )}
            {!loading && hits.map((h, i) => <HitRow key={`${h.ticker}_${h.pattern}`} hit={h} idx={i} />)}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-text-secondary px-1">
        Anchors: ATH · 52W High · 52W Low · YTD · Swing Low. Earnings anchors deferred for v1.
      </div>
    </div>
  );
}
