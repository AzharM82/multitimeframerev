import { useEffect, useMemo, useState } from "react";

/**
 * AVWAP from Earnings.
 *
 * The MASTER TradingView watchlist swept on DESKTOP2 against the 39-minute
 * chart. Four levels, all READ off the operator's own studies rather than
 * recomputed, so every number here is the line he trades against:
 *
 *   AVWAP     VWAP Auto Anchored, Anchor Period = Earnings  (39m)
 *   5D SMA    the standalone SMA(50) on 39m - 50 bars x 39m = 10 bars/session
 *             x 5 sessions, i.e. one full week of candles
 *   21 EMA D  daily EMA 21, from the higher-timeframe overlay
 *   50 SMA D  daily SMA 50, from the same overlay
 *
 * Alerts fire when a candle CLOSES on the far side of a level having closed on
 * the near side of it the bar before. So the whole tab is organised around
 * distance from zero: the closer a name sits to a level, the sooner it can
 * trigger. Chg% / From Open come from FinViz, the same feed the Rotation and
 * Sector Desk tabs use, so they agree with the rest of the portal.
 */

const NEAR_DEFAULT = 1.0;
const NEAR_CHOICES = [0.5, 1.0, 2.0];

/** The saved 39m layout every level is read from - deep-linked per ticker. */
const CHART_ID = "yaYerb4T";

type LevelKey = "avwap" | "sma50" | "ema21d" | "sma50d";
const LEVELS: LevelKey[] = ["avwap", "sma50", "ema21d", "sma50d"];
/**
 * Labels spell the PERIOD out in days. "5D SMA" and "50 SMA D" were nearly
 * indistinguishable in a dense table, and they are completely different lines:
 * one is a week of 39m candles, the other is fifty daily candles. On MXL they
 * sat ~7.6 apart. Reading the wrong column is a real trading error, so the
 * labels carry the distinction rather than relying on the reader.
 */
const LEVEL_LABEL: Record<LevelKey, string> = {
  avwap: "AVWAP",
  sma50: "5-Day SMA",
  ema21d: "21-Day EMA",
  sma50d: "50-Day SMA",
};

/** Shown on hover, so the column can explain itself without stealing width. */
const LEVEL_HINT: Record<LevelKey, string> = {
  avwap: "VWAP Auto Anchored, anchored to the last earnings report (39m chart)",
  sma50: "SMA(50) on the 39-minute chart = 50 x 39m. A session is 390 min = 10 bars, so this is FIVE TRADING DAYS - one week of candles. Not the 50-day SMA.",
  ema21d: "21-period EMA on the DAILY chart, plotted on the 39m via the higher-timeframe overlay",
  sma50d: "50-period SMA on the DAILY chart - fifty daily candles. Not the 5-day line.",
};

interface Row {
  ticker: string;
  sym: string;
  close: number;
  levels: Record<string, number | null>;
  pct: Record<string, number | null>;
  chgPct: number | null;
  chgOpenPct: number | null;
  lastCross: string;
  lastCrossAt: string;
}

interface Snapshot {
  rows: Row[];
  barUtc: string;
  publishedAt: string;
  host: string;
  stale: boolean;
  failed: string[];
  quoteSource: string;
  loaded: boolean;
}

const EMPTY: Snapshot = {
  rows: [], barUtc: "", publishedAt: "", host: "",
  stale: true, failed: [], quoteSource: "", loaded: false,
};

type SortKey = LevelKey | "ticker" | "close" | "chg" | "chgOpen" | "nearest" | "cross";
type Dir = "asc" | "desc";

async function fetchSnapshot(): Promise<Snapshot> {
  try {
    const res = await fetch("/api/avwap-earnings");
    if (!res.ok) return EMPTY;
    const raw = (await res.json()) as Record<string, unknown>;
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const rows = ((raw.rows ?? []) as Record<string, unknown>[]).map((r) => {
      const lv = (r.levels ?? {}) as Record<string, unknown>;
      const pc = (r.pct ?? {}) as Record<string, unknown>;
      const levels: Record<string, number | null> = {};
      const pct: Record<string, number | null> = {};
      for (const k of LEVELS) { levels[k] = n(lv[k]); pct[k] = n(pc[k]); }
      return {
        ticker: String(r.ticker ?? ""),
        sym: String(r.sym ?? ""),
        close: Number(r.close ?? 0),
        levels, pct,
        chgPct: n(r.chgPct),
        chgOpenPct: n(r.chgOpenPct),
        lastCross: String(r.lastCross ?? ""),
        lastCrossAt: String(r.lastCrossAt ?? ""),
      };
    });
    return {
      rows,
      barUtc: String(raw.bar_utc ?? ""),
      publishedAt: String(raw.published_at ?? ""),
      host: String(raw.host ?? ""),
      stale: Boolean(raw.stale ?? true),
      failed: ((raw.failed ?? []) as unknown[]).map(String),
      quoteSource: String(raw.quote_source ?? ""),
      loaded: true,
    };
  } catch {
    return EMPTY;
  }
}

const pctOf = (r: Row, k: LevelKey) => r.pct[k] ?? null;

/** Which level a symbol sits closest to, and how far. Drives ranking and highlight. */
function nearest(r: Row): { level: LevelKey; pct: number } | null {
  let best: { level: LevelKey; pct: number } | null = null;
  for (const k of LEVELS) {
    const p = pctOf(r, k);
    if (p === null) continue;
    if (!best || Math.abs(p) < Math.abs(best.pct)) best = { level: k, pct: p };
  }
  return best;
}

/** Daily regime: where the 21 EMA sits against the 50 SMA, both daily. */
function dailyStack(r: Row): "BULL" | "BEAR" | null {
  const e = r.levels.ema21d, s = r.levels.sma50d;
  if (e === null || s === null || e === undefined || s === undefined) return null;
  return e >= s ? "BULL" : "BEAR";
}

function above(r: Row, k: LevelKey): boolean | null {
  const p = pctOf(r, k);
  return p === null ? null : p >= 0;
}
const aboveAll = (r: Row) => LEVELS.every((k) => above(r, k) === true);
const belowAll = (r: Row) => LEVELS.every((k) => above(r, k) === false);

function tone(p: number | null): string {
  if (p === null) return "text-dim";
  if (p >= 10) return "text-signal-bull";
  if (p > 0) return "text-signal-bull/80";
  if (p <= -10) return "text-signal-bear";
  if (p < 0) return "text-signal-bear/80";
  return "text-text-secondary";
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "America/Los_Angeles",
  }) + " PT";
}

const pacificToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const crossedToday = (r: Row) => !!r.lastCrossAt && r.lastCrossAt.slice(0, 10) === pacificToday();

/**
 * Levels cleared on the last cross bar. "sma50,ema21d:CROSS_UP" — and a row
 * written by an older build, "sma50:CROSS_UP", is just the one-level case.
 */
function crossLevels(r: Row): { levels: LevelKey[]; dir: string } {
  if (!r.lastCross) return { levels: [], dir: "" };
  const [csv, dir] = r.lastCross.split(":");
  return { levels: csv.split(",").filter(Boolean) as LevelKey[], dir: dir ?? "" };
}

const multiLevel = (r: Row) => crossedToday(r) && crossLevels(r).levels.length > 1;

/**
 * Every level the name cleared, not just one of them. Until 2026-08-17 this
 * rendered a single badge chosen by loop order, so a name that reclaimed its
 * AVWAP *and* its 50-day showed only the 50-day — 13 of that day's 58 crossers
 * were under-reported this way, and the phone alert was strictly more
 * informative than the tab.
 *
 * Badges from an earlier session are muted: the value carries forward until the
 * name crosses again, so a bright badge on a stale cross reads as today's event.
 */
function CrossBadges({ row }: { row: Row }) {
  const { levels, dir } = crossLevels(row);
  if (!levels.length) return null;
  const today = crossedToday(row);
  const up = dir === "CROSS_UP";
  const cls = !today
    ? "bg-text-secondary/10 text-text-secondary"
    : up ? "bg-signal-bull/15 text-signal-bull" : "bg-signal-bear/15 text-signal-bear";
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {levels.map((k) => (
        <span key={k}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold whitespace-nowrap ${cls}`}>
          {up ? "▲" : "▼"} {LEVEL_LABEL[k] ?? k}
        </span>
      ))}
    </div>
  );
}

function PctCell({ p, bold = true }: { p: number | null; bold?: boolean }) {
  if (p === null) return <td className="px-2 py-1.5 text-right tabular-nums text-dim">n/a</td>;
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums ${bold ? "font-bold" : ""} ${tone(p)}`}>
      {p > 0 ? "+" : ""}{p.toFixed(2)}%
    </td>
  );
}

function Tile({ label, value, sub, active, onClick, tone: t }: {
  label: string; value: string | number; sub?: string;
  active?: boolean; onClick?: () => void; tone?: string;
}) {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left bg-bg-card border rounded px-3 py-2 min-w-[104px] transition-colors ${
        active ? "border-text-primary ring-1 ring-text-primary" : "border-border"
      } ${clickable ? "hover:bg-bg-secondary cursor-pointer" : "cursor-default"}`}
    >
      <div className="text-[10px] uppercase tracking-wide text-text-secondary">{label}</div>
      <div className={`text-xl font-bold leading-tight ${t || "text-text-primary"}`}>{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </button>
  );
}

export function AvwapEarningsPage() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("nearest");
  const [dir, setDir] = useState<Dir>("asc");
  const [near, setNear] = useState(NEAR_DEFAULT);
  const [nearFilter, setNearFilter] = useState<LevelKey | "any" | null>(null);
  const [trendFilter, setTrendFilter] = useState<"aboveAll" | "belowAll" | null>(null);
  const [crossFilter, setCrossFilter] = useState(false);
  const [multiFilter, setMultiFilter] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => { void fetchSnapshot().then((s) => { if (alive) { setSnap(s); setLoading(false); } }); };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const isNear = (r: Row, k: LevelKey | "any") => {
    if (k === "any") return LEVELS.some((l) => { const p = pctOf(r, l); return p !== null && Math.abs(p) <= near; });
    const p = pctOf(r, k);
    return p !== null && Math.abs(p) <= near;
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { any: 0 };
    for (const k of LEVELS) c[k] = 0;
    for (const r of snap.rows) {
      if (isNear(r, "any")) c.any++;
      for (const k of LEVELS) if (isNear(r, k)) c[k]++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.rows, near]);

  const trendCounts = useMemo(() => ({
    aboveAll: snap.rows.filter(aboveAll).length,
    belowAll: snap.rows.filter(belowAll).length,
    crossed: snap.rows.filter(crossedToday).length,
    multi: snap.rows.filter(multiLevel).length,
  }), [snap.rows]);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    let out = snap.rows;
    if (q) out = out.filter((r) => r.ticker.includes(q));
    if (nearFilter) out = out.filter((r) => isNear(r, nearFilter));
    if (trendFilter === "aboveAll") out = out.filter(aboveAll);
    if (trendFilter === "belowAll") out = out.filter(belowAll);
    if (crossFilter) out = out.filter(crossedToday);
    if (multiFilter) out = out.filter(multiLevel);

    const sign = dir === "asc" ? 1 : -1;
    const num = (v: number | null) => (v === null ? (dir === "asc" ? Infinity : -Infinity) : v);
    const sorted = [...out];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "ticker": return sign * a.ticker.localeCompare(b.ticker);
        case "close": return sign * (a.close - b.close);
        case "chg": return sign * (num(a.chgPct) - num(b.chgPct));
        case "chgOpen": return sign * (num(a.chgOpenPct) - num(b.chgOpenPct));
        case "cross": return sign * a.lastCrossAt.localeCompare(b.lastCrossAt);
        case "nearest": {
          const av = Math.abs(nearest(a)?.pct ?? Infinity), bv = Math.abs(nearest(b)?.pct ?? Infinity);
          return sign * (av - bv);
        }
        default: return sign * (num(pctOf(a, sortKey)) - num(pctOf(b, sortKey)));
      }
    });
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.rows, query, sortKey, dir, near, nearFilter, trendFilter, crossFilter, multiFilter]);

  /** Click a header: same column flips direction, new column starts sensibly. */
  const sortBy = (k: SortKey) => {
    if (k === sortKey) { setDir(dir === "asc" ? "desc" : "asc"); return; }
    setSortKey(k);
    setDir(k === "ticker" || k === "nearest" ? "asc" : "desc");
  };
  const arrow = (k: SortKey) => (k === sortKey ? (dir === "asc" ? " ▲" : " ▼") : "");

  const clearFilters = () => {
    setNearFilter(null); setTrendFilter(null); setCrossFilter(false); setMultiFilter(false); setQuery("");
  };
  const anyFilter = !!nearFilter || !!trendFilter || crossFilter || multiFilter || !!query;

  const exportCsv = () => {
    const head = ["ticker", "sym", "close", "chg_pct", "chg_open_pct",
                  ...LEVELS.flatMap((k) => [`${k}`, `pct_${k}`]), "nearest", "last_cross", "last_cross_at"];
    const lines = rows.map((r) => [
      r.ticker, r.sym, r.close, r.chgPct ?? "", r.chgOpenPct ?? "",
      ...LEVELS.flatMap((k) => [r.levels[k] ?? "", r.pct[k] ?? ""]),
      nearest(r) ? LEVEL_LABEL[nearest(r)!.level] : "", r.lastCross, r.lastCrossAt,
    ].join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `avwap-earnings-${pacificToday()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const Th = ({ k, children, right, hint }: {
    k: SortKey; children: React.ReactNode; right?: boolean; hint?: string;
  }) => (
    <th
      title={hint}
      onClick={() => sortBy(k)}
      className={`px-2 py-2 font-semibold whitespace-nowrap cursor-pointer select-none hover:text-text-primary ${
        right ? "text-right" : "text-left"
      } ${k === sortKey ? "text-text-primary" : ""}`}
    >
      {children}{arrow(k)}
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-black text-text-primary">AVWAP from Earnings</h2>
          <p className="text-xs text-text-secondary mt-0.5">
            MASTER · 39-minute chart · AVWAP (anchor = Earnings) · 5-Day SMA (50×39m ≡ 1 week) · 21-Day EMA · 50-Day SMA
          </p>
        </div>
        <div className="text-right text-[11px] text-text-secondary">
          <div>Bar: <span className="text-text-primary font-semibold">{fmtTime(snap.barUtc)}</span></div>
          <div>
            Published: {fmtTime(snap.publishedAt)}{snap.host && <span className="ml-1">· {snap.host}</span>}
            {snap.stale && snap.loaded && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-signal-bear/15 text-signal-bear">STALE</span>
            )}
          </div>
          {snap.loaded && snap.quoteSource !== "finviz" && (
            <div className="text-signal-bear">Chg% unavailable ({snap.quoteSource || "no quote feed"})</div>
          )}
        </div>
      </div>

      {!loading && !snap.loaded && (
        <div className="bg-signal-bear/10 border border-signal-bear/30 rounded px-3 py-2 text-xs text-signal-bear">
          Could not reach <code>/api/avwap-earnings</code>. This is a feed failure, not an empty market —
          nothing below is current.
        </div>
      )}
      {snap.loaded && snap.failed.length > 0 && (
        <div className="bg-bg-card border border-border rounded px-3 py-2 text-xs text-text-secondary">
          Publisher could not read {snap.failed.length} symbol(s): {snap.failed.join(", ")}
        </div>
      )}

      {/* Near-a-level counts, each a one-click filter. */}
      <div className="flex gap-2 flex-wrap items-center">
        <Tile label="Symbols" value={snap.rows.length} />
        <Tile label={`Near any ±${near}%`} value={counts.any}
              sub={snap.rows.length ? `${Math.round((counts.any / snap.rows.length) * 100)}% of universe` : ""}
              active={nearFilter === "any"} onClick={() => setNearFilter(nearFilter === "any" ? null : "any")} />
        {LEVELS.map((k) => (
          <Tile key={k} label={`Near ${LEVEL_LABEL[k]}`} value={counts[k]}
                sub={snap.rows.length ? `${Math.round((counts[k] / snap.rows.length) * 100)}%` : ""}
                active={nearFilter === k} onClick={() => setNearFilter(nearFilter === k ? null : k)} />
        ))}
        <Tile label="Above all 4" value={trendCounts.aboveAll} tone="text-signal-bull"
              active={trendFilter === "aboveAll"}
              onClick={() => setTrendFilter(trendFilter === "aboveAll" ? null : "aboveAll")} />
        <Tile label="Below all 4" value={trendCounts.belowAll} tone="text-signal-bear"
              active={trendFilter === "belowAll"}
              onClick={() => setTrendFilter(trendFilter === "belowAll" ? null : "belowAll")} />
        <Tile label="Crossed today" value={trendCounts.crossed}
              active={crossFilter} onClick={() => setCrossFilter(!crossFilter)} />
        {/* A name reclaiming two or more levels on one candle is the strong
            signal - it was previously invisible, reported as a single badge. */}
        <Tile label="Multi-level" value={trendCounts.multi} sub="2+ on one candle"
              tone="text-signal-bull"
              active={multiFilter} onClick={() => setMultiFilter(!multiFilter)} />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-text-secondary">Near band:</span>
        {NEAR_CHOICES.map((b) => (
          <button key={b} type="button" onClick={() => setNear(b)}
            className={`px-2 py-1 rounded border ${b === near
              ? "bg-text-primary text-bg-primary border-text-primary"
              : "border-border text-text-secondary hover:text-text-primary"}`}>
            ±{b}%
          </button>
        ))}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter ticker…"
          className="bg-bg-secondary border border-border rounded px-2 py-1 text-text-primary w-32" />
        {anyFilter && (
          <button type="button" onClick={clearFilters}
            className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary">
            Clear filters
          </button>
        )}
        <button type="button" onClick={exportCsv}
          className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary">
          Export CSV ({rows.length})
        </button>
        <span className="text-dim ml-auto">{rows.length} of {snap.rows.length}</span>
      </div>

      <div className="bg-bg-card border border-border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-text-secondary border-b border-border">
              <Th k="ticker">Ticker</Th>
              <Th k="close" right>Close</Th>
              <Th k="chg" right>Chg %</Th>
              <Th k="chgOpen" right>From Open</Th>
              {LEVELS.map((k) => <Th key={k} k={k} right hint={LEVEL_HINT[k]}>Δ% {LEVEL_LABEL[k]}</Th>)}
              <Th k="nearest">Nearest</Th>
              <th className="px-2 py-2 font-semibold text-left">Daily</th>
              <Th k="cross">Last cross</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={11} className="px-3 py-6 text-text-secondary">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-6 text-text-secondary">No symbols match.</td></tr>
            )}
            {rows.map((r) => {
              const nr = nearest(r);
              // Highlight the whole row when it is within the band of ANY level:
              // those are the names a single candle close can trigger.
              const hot = nr !== null && Math.abs(nr.pct) <= near;
              const stack = dailyStack(r);
              return (
                <tr key={r.ticker}
                    className={`border-b border-border/50 hover:bg-bg-secondary/50 ${
                      hot ? "bg-signal-bull/5 border-l-2 border-l-signal-bull" : ""}`}>
                  <td className="px-2 py-1.5 font-bold align-top">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <a href={`https://www.tradingview.com/chart/${CHART_ID}/?symbol=${encodeURIComponent(r.sym || r.ticker)}`}
                         target="_blank" rel="noopener noreferrer"
                         title={`Open ${r.sym || r.ticker} on the 39m layout`}
                         className="text-text-primary hover:underline">
                        {r.ticker}
                      </a>
                      {multiLevel(r) && (
                        <span title={`Cleared ${crossLevels(r).levels.length} levels on the same candle`}
                              className="px-1 py-0.5 rounded text-[9px] font-bold bg-signal-bull/25 text-signal-bull">
                          ×{crossLevels(r).levels.length}
                        </span>
                      )}
                    </div>
                    <CrossBadges row={r} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-text-primary">{r.close.toFixed(2)}</td>
                  <PctCell p={r.chgPct} />
                  <PctCell p={r.chgOpenPct} bold={false} />
                  {LEVELS.map((k) => <PctCell key={k} p={pctOf(r, k)} />)}
                  <td className="px-2 py-1.5 text-[11px] text-text-secondary whitespace-nowrap">
                    {nr ? `${LEVEL_LABEL[nr.level]} ${nr.pct > 0 ? "+" : ""}${nr.pct.toFixed(2)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-[10px] whitespace-nowrap">
                    {stack === null ? <span className="text-dim">—</span> : (
                      <span className={stack === "BULL" ? "text-signal-bull" : "text-signal-bear"}>
                        {stack === "BULL" ? "21>50" : "21<50"}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-[10px] text-text-secondary whitespace-nowrap">
                    {r.lastCrossAt ? fmtTime(r.lastCrossAt) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
