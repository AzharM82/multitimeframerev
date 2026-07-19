import { useEffect, useMemo, useState } from "react";
import type {
  RotQuotesResponse,
  RotPerformanceResponse,
  RotWeeklyHistoryResponse,
} from "../types.js";
import { getRotQuotes, getRotPerformance, getRotWeeklyHistory } from "../services/api.js";
import { buildTree, buildIndustryTrends, type Metric } from "./rotation/rotationData.js";

/**
 * Rotation — sector / industry rotation across the 878-symbol universe.
 *
 * Data: Polygon snapshot (live quotes) + grouped-daily aggregates (period and
 * weekly performance), via /api/rot-*. Classification ships from the API so the
 * universe lives in exactly one place.
 *
 * NOTE ON THE UI: this view is intentionally plain — sortable tables over the
 * shared data layer in ./rotation/rotationData.ts. The original app's
 * circle-packing visual was deliberately not ported: its circles were uniformly
 * sized (its market-cap field was always absent, so every node got value 1),
 * meaning it implied a weighting it never actually had. All aggregation lives in
 * rotationData.ts, so replacing this file with a treemap, heat grid or scatter
 * requires no backend or data-layer changes.
 */

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${t}`;

const METRICS: { key: Metric; label: string }[] = [
  { key: "day", label: "Day %" },
  { key: "fromOpen", label: "From Open %" },
  { key: "period", label: "Period %" },
];

const pct = (v: number | null, dp = 2) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`);
const tone = (v: number | null) =>
  v === null ? "text-dim" : v > 0 ? "text-signal-bull" : v < 0 ? "text-signal-bear" : "text-text-secondary";

/** Horizontal green/red split bar — breadth at a glance. */
function BreadthBar({ green, red }: { green: number; red: number }) {
  const total = green + red;
  if (total === 0) return <span className="text-dim">—</span>;
  const g = (green / total) * 100;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-16 h-2 bg-bg-secondary rounded-sm overflow-hidden align-middle">
        <span className="block h-full bg-signal-bull" style={{ width: `${g}%` }} />
      </span>
      <span className="tabular-nums text-[10px] text-text-secondary">{g.toFixed(0)}%</span>
    </span>
  );
}

export function RotationPage() {
  const [quotes, setQuotes] = useState<RotQuotesResponse | null>(null);
  const [perf, setPerf] = useState<RotPerformanceResponse | null>(null);
  const [history, setHistory] = useState<RotWeeklyHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [metric, setMetric] = useState<Metric>("day");
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showTrends, setShowTrends] = useState(false);

  // Quotes drive the tree; load them first and render as soon as they land.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRotQuotes(true)
      .then((d) => !cancelled && setQuotes(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Period performance is slower; fetch separately so it never blocks the tree.
  useEffect(() => {
    let cancelled = false;
    getRotPerformance(period)
      .then((d) => !cancelled && setPerf(d))
      .catch(() => !cancelled && setPerf(null));
    return () => {
      cancelled = true;
    };
  }, [period]);

  // Weekly history is the heaviest call — only fetch it when actually shown.
  useEffect(() => {
    if (!showTrends || history) return;
    let cancelled = false;
    getRotWeeklyHistory(4)
      .then((d) => !cancelled && setHistory(d))
      .catch(() => !cancelled && setHistory(null));
    return () => {
      cancelled = true;
    };
  }, [showTrends, history]);

  const tree = useMemo(() => buildTree(quotes, perf, metric), [quotes, perf, metric]);
  const trends = useMemo(() => buildIndustryTrends(quotes, history), [quotes, history]);

  if (loading) {
    return (
      <div className="text-center py-16 text-text-secondary text-xs uppercase tracking-widest">
        Loading rotation …
      </div>
    );
  }

  if (error || !quotes) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="font-[var(--font-playfair)] text-lg font-bold mb-2">Rotation unavailable</div>
        <p className="text-sm text-text-secondary">{error ?? "No data."}</p>
      </div>
    );
  }

  const periodWaiting = metric === "period" && !perf;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">Market Avg</div>
          <div className={`font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums ${tone(tree.avg)}`}>
            {pct(tree.avg)}
          </div>
        </div>
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">Advancing</div>
          <div className="font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums">
            {tree.greenPct === null ? "—" : `${(tree.greenPct * 100).toFixed(0)}%`}
          </div>
        </div>
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">Symbols</div>
          <div className="font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums">
            {tree.stockCount}
          </div>
        </div>
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">Sectors</div>
          <div className="font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums">
            {tree.sectors.length}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {METRICS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              metric === m.key
                ? "bg-text-primary text-bg-primary border-text-primary"
                : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {m.label}
          </button>
        ))}
        {metric === "period" && (
          <>
            <span className="w-px h-4 bg-border mx-1" />
            {(["weekly", "monthly"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                  period === p
                    ? "bg-text-primary text-bg-primary border-text-primary"
                    : "border-border text-text-secondary hover:text-text-primary"
                }`}
              >
                {p === "weekly" ? "Week to date" : "Month to date"}
              </button>
            ))}
          </>
        )}
        <span className="flex-1" />
        <button
          onClick={() => setShowTrends((v) => !v)}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
            showTrends
              ? "bg-text-primary text-bg-primary border-text-primary"
              : "border-border text-text-secondary hover:text-text-primary"
          }`}
        >
          4-Week Trend
        </button>
      </div>

      {periodWaiting && (
        <div className="text-[11px] text-text-secondary">Loading period performance …</div>
      )}
      {metric === "period" && perf && (
        <div className="text-[10px] uppercase tracking-wider text-text-secondary">
          {perf.startDate} open → {perf.endDate} close
        </div>
      )}

      {/* Sector → Industry */}
      <div className="bg-bg-card border border-border rounded overflow-x-auto">
        <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
          Sectors
          <span className="font-normal normal-case text-text-secondary"> · click to expand industries</span>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
              <th className="text-left px-3 py-1.5">Sector</th>
              <th className="text-right px-2 py-1.5">Avg</th>
              <th className="text-left px-2 py-1.5">Breadth</th>
              <th className="text-right px-2 py-1.5">Adv</th>
              <th className="text-right px-2 py-1.5">Dec</th>
              <th className="text-right px-3 py-1.5">Symbols</th>
            </tr>
          </thead>
          <tbody>
            {tree.sectors.map((s) => (
              <>
                <tr
                  key={s.name}
                  onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                  className="border-b border-border last:border-b-0 cursor-pointer hover:bg-bg-secondary transition-colors"
                >
                  <td className="px-3 py-1.5 font-bold">
                    <span className="text-dim mr-1.5">{expanded === s.name ? "▾" : "▸"}</span>
                    {s.name}
                  </td>
                  <td className={`text-right px-2 py-1.5 tabular-nums font-semibold ${tone(s.avg)}`}>{pct(s.avg)}</td>
                  <td className="px-2 py-1.5">
                    <BreadthBar green={s.greenCount} red={s.redCount} />
                  </td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-signal-bull">{s.greenCount}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-signal-bear">{s.redCount}</td>
                  <td className="text-right px-3 py-1.5 tabular-nums text-text-secondary">{s.stockCount}</td>
                </tr>
                {expanded === s.name &&
                  s.industries.map((ind) => (
                    <tr key={`${s.name}-${ind.name}`} className="border-b border-border bg-bg-primary">
                      <td className="px-3 py-1 pl-8 text-[11px]">{ind.name}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(ind.avg)}`}>{pct(ind.avg)}</td>
                      <td className="px-2 py-1">
                        <BreadthBar green={ind.greenCount} red={ind.redCount} />
                      </td>
                      <td className="text-right px-2 py-1 tabular-nums text-signal-bull">{ind.greenCount}</td>
                      <td className="text-right px-2 py-1 tabular-nums text-signal-bear">{ind.redCount}</td>
                      <td className="text-right px-3 py-1 tabular-nums text-text-secondary">
                        <span className="text-[10px]">{ind.stocks.length}</span>
                      </td>
                    </tr>
                  ))}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* 4-week industry trend */}
      {showTrends && (
        <div className="bg-bg-card border border-border rounded overflow-x-auto">
          <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
            Industry Trend
            <span className="font-normal normal-case text-text-secondary">
              {" "}· avg weekly performance, Monday open → Friday close
            </span>
          </div>
          {trends.length === 0 ? (
            <div className="text-center py-10 text-xs text-text-secondary">Loading weekly history …</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
                  <th className="text-left px-3 py-1.5">Industry</th>
                  <th className="text-left px-2 py-1.5">Sector</th>
                  {(history?.weeks ?? []).map((w) => (
                    <th key={w.weekIndex} className="text-right px-2 py-1.5">
                      {w.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trends.slice(0, 40).map((t) => (
                  <tr key={t.industry} className="border-b border-border last:border-b-0 hover:bg-bg-secondary">
                    <td className="px-3 py-1.5">{t.industry}</td>
                    <td className="px-2 py-1.5 text-text-secondary text-[10px]">{t.sector}</td>
                    {t.weeks.map((v, i) => (
                      <td key={i} className={`text-right px-2 py-1.5 tabular-nums ${tone(v)}`}>
                        {pct(v, 1)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {trends.length > 40 && (
            <div className="px-3 py-2 text-[10px] text-text-secondary border-t border-border">
              Showing top 40 of {trends.length} industries by current week.
            </div>
          )}
        </div>
      )}

      {/* Leaders / laggards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {([["Leaders", true], ["Laggards", false]] as const).map(([title, top]) => {
          const all = tree.sectors
            .flatMap((s) => s.industries.flatMap((i) => i.stocks))
            .filter((s) => s.value !== null)
            .sort((a, b) => (top ? (b.value ?? 0) - (a.value ?? 0) : (a.value ?? 0) - (b.value ?? 0)))
            .slice(0, 12);
          return (
            <div key={title} className="bg-bg-card border border-border rounded overflow-x-auto">
              <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">{title}</div>
              <table className="w-full text-xs">
                <tbody>
                  {all.map((s) => (
                    <tr key={s.ticker} className="border-b border-border last:border-b-0 hover:bg-bg-secondary">
                      <td className="px-3 py-1">
                        <a href={TV(s.ticker)} target="_blank" rel="noreferrer" className="font-bold hover:underline">
                          {s.ticker}
                        </a>
                      </td>
                      <td className="px-2 py-1 text-text-secondary text-[10px] truncate max-w-[160px]">
                        {s.industry}
                      </td>
                      <td className="text-right px-2 py-1 tabular-nums">{s.price ? s.price.toFixed(2) : "—"}</td>
                      <td className={`text-right px-3 py-1 tabular-nums font-semibold ${tone(s.value)}`}>
                        {pct(s.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] uppercase tracking-wider text-text-secondary text-center pb-2">
        {quotes.count} of {tree.stockCount} symbols quoted · Polygon.io · Not financial advice
      </p>
    </div>
  );
}
