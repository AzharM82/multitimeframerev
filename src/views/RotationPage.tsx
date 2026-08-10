import { useEffect, useMemo, useState } from "react";
import type {
  RotQuotesResponse,
  RotPerformanceResponse,
  RotWeeklyHistoryResponse,
  RotationEnrichMap,
} from "../types.js";
import {
  getRotQuotes,
  getRotPerformance,
  getRotWeeklyHistory,
  getRotationStocks,
} from "../services/api.js";
import { buildTree, buildIndustryTrends, type Metric, type StockNode } from "./rotation/rotationData.js";
import { useMarketHours } from "../hooks/useMarketHours.js";
import { useTableSort, SortHeaderRow, type SortColumn } from "./shared/tableSort.js";

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

// ─── Industry drill-down: the Sector Desk column set ─────────────────────────

/** A tree stock joined to its FinViz price context. */
interface EnrichedStock extends StockNode {
  chg: number | null;
  changeFromOpen: number | null;
  relVol: number | null;
  dollarVol: number | null;
  distEma10: number | null;
  distEma20: number | null;
  distSma50: number | null;
  distSma200: number | null;
}

type StockSortKey =
  | "ticker" | "chg" | "changeFromOpen" | "relVol" | "dollarVol"
  | "distEma10" | "distEma20" | "distSma50" | "distSma200";

const STOCK_COLUMNS: SortColumn<StockSortKey>[] = [
  { key: "ticker", label: "Ticker", num: false },
  { key: "chg", label: "Chg", num: true },
  { key: "changeFromOpen", label: "Chg Open", num: true },
  { key: "relVol", label: "RVol", num: true },
  { key: "dollarVol", label: "$ Vol", num: true },
  { key: "distEma10", label: "10 EMA", num: true },
  { key: "distEma20", label: "20 EMA", num: true },
  { key: "distSma50", label: "50 SMA", num: true },
  { key: "distSma200", label: "200 SMA", num: true },
];

const stockSortValue = (s: EnrichedStock, key: StockSortKey): number | string | null =>
  key === "ticker" ? s.ticker : s[key];

const hasNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const fmtDist = (v: number | null | undefined) => (hasNum(v) ? pct(v, 1) : "–");
const fmtX = (v: number | null | undefined) => (hasNum(v) ? `${v.toFixed(2)}×` : "–");
const fmtUsd = (v: number | null | undefined) =>
  !hasNum(v) || v <= 0 ? "–" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`;

function IndustryStocks({
  industry,
  sector,
  stocks,
  enrich,
  enrichError,
}: {
  industry: string;
  sector: string;
  stocks: StockNode[];
  enrich: RotationEnrichMap | null;
  enrichError: string | null;
}) {
  const joined = useMemo<EnrichedStock[]>(
    () =>
      stocks.map((s) => {
        const e = enrich?.[s.ticker];
        return {
          ...s,
          chg: e?.chg ?? null,
          changeFromOpen: e?.changeFromOpen ?? null,
          relVol: e?.relVol ?? null,
          dollarVol: e?.dollarVol ?? null,
          distEma10: e?.distEma10 ?? null,
          distEma20: e?.distEma20 ?? null,
          distSma50: e?.distSma50 ?? null,
          distSma200: e?.distSma200 ?? null,
        };
      }),
    [stocks, enrich],
  );

  // Default: change-from-open desc — same question as the Sector Desk, same answer.
  const { rows, sortKey, sortDir, onSort } = useTableSort<EnrichedStock, StockSortKey>(
    joined,
    stockSortValue,
    "changeFromOpen",
  );

  const covered = joined.filter((s) => s.changeFromOpen !== null).length;

  return (
    <div className="bg-bg-card border border-border rounded overflow-x-auto">
      <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
        {industry}
        <span className="font-normal normal-case text-text-secondary"> · {sector} · {stocks.length} names</span>
      </div>

      {/* Two clocks in one tab: the tree above is Polygon (~15 min delayed), these
          rows are FinViz real-time. Say so rather than let the numbers disagree
          silently. */}
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border">
        FinViz real-time · {covered}/{joined.length} covered
        {enrichError && <span className="text-signal-bear"> · {enrichError}</span>}
      </div>

      <table className="w-full text-xs">
        <thead>
          <SortHeaderRow
            columns={STOCK_COLUMNS}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            cellClass="px-2 py-1.5 whitespace-nowrap"
          />
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.ticker} className="border-b border-border/50 last:border-b-0 hover:bg-bg-secondary">
              <td className="px-2 py-1">
                <a href={TV(s.ticker)} target="_blank" rel="noreferrer" className="font-bold hover:underline">
                  {s.ticker}
                </a>
              </td>
              <td className={`text-right px-2 py-1 tabular-nums ${tone(s.chg)}`}>{fmtDist(s.chg)}</td>
              <td className={`text-right px-2 py-1 tabular-nums font-semibold ${tone(s.changeFromOpen)}`}>
                {fmtDist(s.changeFromOpen)}
              </td>
              <td className="text-right px-2 py-1 tabular-nums text-text-secondary">{fmtX(s.relVol)}</td>
              <td className="text-right px-2 py-1 tabular-nums text-text-secondary">{fmtUsd(s.dollarVol)}</td>
              <td className={`text-right px-2 py-1 tabular-nums ${tone(s.distEma10)}`}>{fmtDist(s.distEma10)}</td>
              <td className={`text-right px-2 py-1 tabular-nums ${tone(s.distEma20)}`}>{fmtDist(s.distEma20)}</td>
              <td className={`text-right px-2 py-1 tabular-nums ${tone(s.distSma50)}`}>{fmtDist(s.distSma50)}</td>
              <td className={`text-right px-2 py-1 tabular-nums ${tone(s.distSma200)}`}>{fmtDist(s.distSma200)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {covered < joined.length && (
        <div className="px-3 py-2 text-[10px] text-text-secondary border-t border-border">
          "–" means FinViz returns no row for the ticker at all — it has been delisted or renamed since the
          universe was curated (13 of 878; everything else is covered). The 5-day line is omitted on this
          tab — it needs Alpaca 30-min bars, which don't scale to ~880 names.
        </div>
      )}
    </div>
  );
}

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

  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const marketOpen = useMarketHours();

  const [metric, setMetric] = useState<Metric>("fromOpen");
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showTrends, setShowTrends] = useState(false);

  // Per-stock FinViz context for the industry drill-down.
  const [enrich, setEnrich] = useState<RotationEnrichMap | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [openIndustry, setOpenIndustry] = useState<{ sector: string; industry: string } | null>(null);

  // Quotes drive the tree; load them first and render as soon as they land.
  // Re-runs whenever `tick` advances (auto-refresh or manual).
  useEffect(() => {
    let cancelled = false;
    if (tick === 0) setLoading(true);
    else setRefreshing(true);
    setError(null);
    getRotQuotes(true)
      .then((d) => {
        if (cancelled) return;
        setQuotes(d);
        setFetchedAt(new Date());
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /**
   * Auto-refresh while the market is open.
   *
   * 60s is deliberate, not conservative: the Polygon plan in use has no
   * real-time entitlement (the snapshot omits lastTrade/lastQuote), so the
   * underlying data is ~15 minutes delayed. Polling faster would re-fetch
   * identical numbers and burn rate limit for nothing. The server cache
   * (30s for quotes) absorbs any overlap.
   */
  useEffect(() => {
    if (!marketOpen) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [marketOpen]);

  /**
   * Per-stock enrichment. Optional by design: it rides the sector-desk cron, so
   * it 503s until that warm lands, and the tree must render regardless. Refreshed
   * on the same tick as the quotes.
   */
  useEffect(() => {
    let cancelled = false;
    getRotationStocks()
      .then((r) => {
        if (cancelled) return;
        setEnrich(r.data);
        setEnrichError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setEnrich(null);
        setEnrichError(
          /no_panel_data|503/.test(e.message) ? "waiting for the first Sector Desk warm" : e.message,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Period performance is slower; fetch separately so it never blocks the tree.
  useEffect(() => {
    let cancelled = false;
    getRotPerformance(period)
      .then((d) => !cancelled && setPerf(d))
      .catch(() => !cancelled && setPerf(null));
    return () => {
      cancelled = true;
    };
  }, [period, tick]);

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
          onClick={() => setTick((t) => t + 1)}
          disabled={refreshing}
          className="px-2.5 py-1 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
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

      {/* Data freshness — the delay is stated explicitly rather than implied.
          The Polygon plan has no real-time entitlement, so quotes are ~15 min
          behind regardless of how often we poll. */}
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary">
        <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? "bg-signal-bull animate-pulse" : "bg-dim"}`} />
        <span>
          {marketOpen ? "Auto-refreshing every 60s" : "Market closed — last session"}
        </span>
        {fetchedAt && (
          <>
            <span className="text-dim">·</span>
            <span>
              Fetched{" "}
              {fetchedAt.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZone: "America/Los_Angeles",
              })}{" "}
              PT
            </span>
          </>
        )}
        <span className="text-dim">·</span>
        <span title="Polygon plan has no real-time entitlement; snapshot omits lastTrade/lastQuote">
          Source ~15 min delayed
        </span>
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
                    <tr
                      key={`${s.name}-${ind.name}`}
                      onClick={() =>
                        setOpenIndustry((cur) =>
                          cur && cur.industry === ind.name && cur.sector === s.name
                            ? null
                            : { sector: s.name, industry: ind.name },
                        )
                      }
                      className={`border-b border-border bg-bg-primary cursor-pointer hover:bg-bg-secondary transition-colors ${
                        openIndustry?.industry === ind.name && openIndustry?.sector === s.name
                          ? "text-text-primary"
                          : ""
                      }`}
                    >
                      <td className="px-3 py-1 pl-8 text-[11px]">
                        <span className="text-dim mr-1.5">
                          {openIndustry?.industry === ind.name && openIndustry?.sector === s.name ? "▾" : "▸"}
                        </span>
                        {ind.name}
                      </td>
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

      {/* Industry drill-down — the Sector Desk column set for the picked industry */}
      {openIndustry &&
        (() => {
          const sec = tree.sectors.find((s) => s.name === openIndustry.sector);
          const ind = sec?.industries.find((i) => i.name === openIndustry.industry);
          if (!ind) return null;
          return (
            <IndustryStocks
              industry={ind.name}
              sector={ind.sector}
              stocks={ind.stocks}
              enrich={enrich}
              enrichError={enrichError}
            />
          );
        })()}

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
