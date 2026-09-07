import { useCallback, useEffect, useMemo, useState } from "react";
import type { SwingResultsResponse, SwingRow, SwingStack, SwingReversalState, SwingSubStage } from "../types.js";
import { getSwingResults, getSwingUniverse, uploadSwingUniverse, runSwingScan } from "../services/api.js";
import { useTableSort, SortHeaderRow, type SortColumn } from "./shared/tableSort.js";
import { SwingGroups, type GroupLevel } from "./swing/SwingGroups.js";
import { fmtTimePT, PT_LABEL } from "../utils/time.js";

/**
 * Swing Strength — a FIXED list of stocks, each shown against three lenses.
 *
 * Not a scanner. The operator curates the list in FinViz and pastes the export
 * here; a nightly scan then scores every name so the same stocks can be watched
 * moving between states day after day.
 *
 *   Lens 1  MA stack, daily: 10 EMA > 20 EMA > 50 SMA > 200 SMA
 *   Lens 2  the operator's ThinkOrSwim "Jonesy Signals" study → four reversal states
 *   Lens 3  Weinstein stage, weekly, sub-stages 1A–4B
 *
 * Layout (2026-09-06 rework, operator request): one compact filter panel —
 * checkbox chips per lens, multi-select WITHIN a lens (OR), AND across lenses,
 * with counts on every chip — replaces the three tile rows. The default view is
 * the operator's "positive on all three": bull stack ∧ bullish reversal ∧
 * Stage 2, sorted by change from open. Tickers open TradingView. The view does
 * no indicator arithmetic: every level, distance, flag and price comes from the API.
 */

// ─── Columns ────────────────────────────────────────────────────────────────

type SortKey = "ticker" | "sector" | "industry" | "mcap" | "last" | "chg" | "open" | "week"
  | "d10" | "d20" | "d50" | "d200" | "score" | "stack"
  | "leg" | "stoch" | "revUp" | "revDown" | "signal"
  | "stage" | "wk" | "d30" | "slope" | "mrs" | "rvol";

const COLUMNS: SortColumn<SortKey>[] = [
  { key: "ticker", label: "Ticker", num: false, title: "Click a ticker to open it in TradingView" },
  { key: "sector", label: "Sector", num: false },
  { key: "industry", label: "Industry", num: false },
  { key: "mcap", label: "Mkt cap", num: true, title: "FinViz market cap" },
  { key: "last", label: "Last", num: true, title: "Closing price on the snapshot day" },
  { key: "chg", label: "% Chg", num: true, title: "Close vs previous close" },
  { key: "open", label: "From open", num: true, title: "Close vs the day's open" },
  { key: "week", label: "Week", num: true, title: "Close vs the close 5 trading days earlier" },
  { key: "d10", label: "vs 10 EMA", num: true, title: "% distance of price from the 10-day EMA" },
  { key: "d20", label: "vs 20 EMA", num: true },
  { key: "d50", label: "vs 50 SMA", num: true },
  { key: "d200", label: "vs 200 SMA", num: true },
  { key: "score", label: "10>20 · 20>50 · 50>200", num: true, title: "The three inequalities of the stack" },
  { key: "stack", label: "Stack", num: false },
  { key: "leg", label: "Leg", num: true, title: "ZigZag leg direction and bars since it began" },
  { key: "stoch", label: "K / D", num: true, title: "StochasticFull 8·12·3 on the last bar" },
  { key: "revUp", label: "Bull rev", num: true, title: "Bars since Going_Up last fired. 0 = today" },
  { key: "revDown", label: "Bear rev", num: true, title: "Bars since Going_Down last fired. 0 = today" },
  { key: "signal", label: "Reversal", num: false, title: "The study's Bullish plot as four states: Triggered = turned within 2 bars, In progress = older" },
  { key: "stage", label: "Stage", num: false, title: "Weinstein stage on weekly bars with the spec's sub-stage" },
  { key: "wk", label: "Wks", num: true, title: "Consecutive weeks in the current primary stage" },
  { key: "d30", label: "vs 30w", num: true, title: "% distance of the weekly close from the 30-week SMA" },
  { key: "slope", label: "Slope", num: true, title: "% change of the 30-week SMA over 4 weeks" },
  { key: "mrs", label: "MRS", num: true, title: "Mansfield relative strength vs SPY" },
  { key: "rvol", label: "RVOL", num: true, title: "This week's volume / 20-week average" },
];

const STACK_LABEL: Record<SwingStack, string> = { bull: "Bull stack", bear: "Bear stack", mixed: "Mixed", "n/a": "Not enough bars" };
const STACK_TONE: Record<SwingStack, string> = { bull: "text-signal-bull", bear: "text-signal-bear", mixed: "text-text-secondary", "n/a": "text-dim" };
const STATE_LABEL: Record<SwingReversalState, string> = {
  "bull-triggered": "Bullish · triggered", "bull-inprogress": "Bullish · in progress",
  "bear-triggered": "Bearish · triggered", "bear-inprogress": "Bearish · in progress",
};
const STATE_TONE: Record<SwingReversalState, string> = {
  "bull-triggered": "text-signal-bull", "bull-inprogress": "text-signal-bull/80",
  "bear-triggered": "text-signal-bear", "bear-inprogress": "text-signal-bear/80",
};
const STAGE_TONE: Record<SwingSubStage, string> = {
  "1A": "text-text-secondary", "1B": "text-text-primary", "2A": "text-signal-bull", "2B": "text-signal-bull/80",
  "3A": "text-amber-600", "3B": "text-amber-700", "4A": "text-signal-bear/80", "4B": "text-signal-bear",
};
const STAGE_NAME: Record<SwingSubStage, string> = {
  "1A": "Early base", "1B": "Late base", "2A": "Early uptrend", "2B": "Extended uptrend",
  "3A": "Early top", "3B": "Late top", "4A": "Early downtrend", "4B": "Late downtrend",
};

const fmtPct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}%`;
const pctTone = (v: number | null | undefined) =>
  v === null || v === undefined ? "text-dim" : v > 0 ? "text-signal-bull" : v < 0 ? "text-signal-bear" : "text-text-secondary";
const fmtCap = (m: number | null) => (m === null ? "—" : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}B` : `${m.toFixed(0)}M`);
const tvUrl = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t.replace("-", "."))}`;

function sortValue(r: SwingRow, key: SortKey): number | string | null {
  switch (key) {
    case "ticker": return r.ticker;
    case "sector": return r.sector;
    case "industry": return r.industry;
    case "mcap": return r.marketCapM;
    case "last": return r.px?.last ?? r.ma?.close ?? null;
    case "chg": return r.px?.changePct ?? null;
    case "open": return r.px?.fromOpenPct ?? null;
    case "week": return r.px?.weekPct ?? null;
    case "d10": return r.ma?.d10 ?? null;
    case "d20": return r.ma?.d20 ?? null;
    case "d50": return r.ma?.d50 ?? null;
    case "d200": return r.ma?.d200 ?? null;
    case "score": return r.ma?.score ?? null;
    case "stack": return r.ma?.stack ?? "zzz";
    case "leg": return r.reversal?.legUp === null || r.reversal?.legUp === undefined ? null : (r.reversal.legUp ? 1 : -1) * (r.reversal.legBars ?? 0);
    case "stoch": return r.reversal?.fullK ?? null;
    case "revUp": return r.reversal?.goingUpBarsAgo === null || r.reversal?.goingUpBarsAgo === undefined ? null : -r.reversal.goingUpBarsAgo;
    case "revDown": return r.reversal?.goingDownBarsAgo === null || r.reversal?.goingDownBarsAgo === undefined ? null : -r.reversal.goingDownBarsAgo;
    case "signal": return r.reversal?.state ?? "zzz";
    case "stage": return r.stage?.subStage ?? "zzz";
    case "wk": return r.stage?.weeksInStage ?? null;
    case "d30": return r.stage?.distPct ?? null;
    case "slope": return r.stage?.slope4wPct ?? null;
    case "mrs": return r.stage?.mrs ?? null;
    case "rvol": return r.stage?.rvol ?? null;
  }
}

// ─── Small parts ────────────────────────────────────────────────────────────

function Check({ v }: { v: boolean | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-dim">·</span>;
  return <span className={v ? "text-signal-bull" : "text-signal-bear"}>{v ? "✓" : "✗"}</span>;
}

type Tri = "" | "y" | "n";
/** A three-state chip: any → ✓ only → ✗ only → any. */
function TriChip({ label, value, onChange, yes = "✓", no = "✗", title }: {
  label: string; value: Tri; onChange: (v: Tri) => void; yes?: string; no?: string; title?: string;
}) {
  const next: Record<Tri, Tri> = { "": "y", y: "n", n: "" };
  const cls = value === "y" ? "border-signal-bull text-signal-bull" : value === "n" ? "border-signal-bear text-signal-bear" : "border-border text-text-secondary hover:text-text-primary";
  return (
    <button onClick={() => onChange(next[value])} title={title ?? `${label}: any → ${yes} → ${no}`}
      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors ${cls}`}>
      {label} <span className="ml-1">{value === "y" ? yes : value === "n" ? no : "any"}</span>
    </button>
  );
}

/** A checkbox chip for the multi-select filter panel: ☑ / ☐ with a count. */
function Chip({ label, count, on, tone, onToggle, title }: { label: string; count: number; on: boolean; tone?: string; onToggle: () => void; title?: string }) {
  return (
    <button onClick={onToggle} title={title} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] transition-colors ${
        on ? "border-text-primary bg-bg-secondary text-text-primary" : "border-border text-text-secondary hover:text-text-primary hover:bg-bg-secondary/50"}`}>
      <span className={`text-[12px] leading-none ${on ? "text-text-primary" : "text-dim"}`}>{on ? "☑" : "☐"}</span>
      <span className={on && tone ? tone : ""}>{label}</span>
      <span className="tabular-nums text-dim">{count}</span>
    </button>
  );
}

function useSet<T>(initial: T[]) {
  const [set, setSet] = useState<Set<T>>(() => new Set(initial));
  const toggle = (v: T) => setSet((s) => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  const reset = (vals: T[]) => setSet(new Set(vals));
  return { set, toggle, reset, has: (v: T) => set.has(v), size: set.size };
}

// The operator's default: positive on all three lenses.
const DEFAULT_STACK: SwingStack[] = ["bull"];
const DEFAULT_REV: SwingReversalState[] = ["bull-triggered", "bull-inprogress"];
const DEFAULT_STAGE: SwingSubStage[] = ["2A", "2B"];

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="w-20 shrink-0 pt-1 text-[10px] uppercase tracking-wider text-text-secondary">{title}</span>
      <div className="flex items-center gap-1.5 flex-wrap flex-1">{children}</div>
      {right}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function SwingStrengthPage() {
  const [data, setData] = useState<SwingResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState<string | null>(null);
  const [universeCount, setUniverseCount] = useState<number | null>(null);
  const [universeAt, setUniverseAt] = useState<string | null>(null);

  // Lens filters: multi-select within a lens (OR), AND across lenses. Empty = any.
  const selStack = useSet<SwingStack>(DEFAULT_STACK);
  const selRev = useSet<SwingReversalState>(DEFAULT_REV);
  const selStage = useSet<SwingSubStage>(DEFAULT_STAGE);
  const [breakoutOnly, setBreakoutOnly] = useState(false);

  // Secondary filters (the fine-grained ones are collapsed by default).
  const [fSector, setFSector] = useState<string>("");
  const [fIndustry, setFIndustry] = useState<string>("");
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [f1, setF1] = useState<Tri>(""); const [f2, setF2] = useState<Tri>(""); const [f3, setF3] = useState<Tri>("");
  const [fP50, setFP50] = useState<Tri>(""); const [fP200, setFP200] = useState<Tri>("");
  const [fLeg, setFLeg] = useState<Tri>("");
  const [minScore, setMinScore] = useState<number>(0);

  const [groupLevel, setGroupLevel] = useState<GroupLevel>("sector");
  const [showGroups, setShowGroups] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState<"" | "upload" | "scan">("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (d: string | null) => {
    setLoading(true); setError(null);
    try {
      const [res, uni] = await Promise.all([getSwingResults(d ?? undefined), getSwingUniverse()]);
      setData(res); setUniverseCount(uni.count); setUniverseAt(uni.updatedAt);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "failed to load");
      try { const uni = await getSwingUniverse(); setUniverseCount(uni.count); setUniverseAt(uni.updatedAt); } catch { /* keep */ }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(date); }, [date, load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const sectors = useMemo(() => [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort(), [rows]);
  const industries = useMemo(
    () => [...new Set(rows.filter((r) => !fSector || r.sector === fSector).map((r) => r.industry).filter(Boolean))].sort(),
    [rows, fSector],
  );

  // Chip counts are of the WHOLE snapshot: a chip always says how many exist, not how many survive the other filters.
  const counts = useMemo(() => {
    const st: Record<SwingStack, number> = { bull: 0, mixed: 0, bear: 0, "n/a": 0 };
    const rv: Record<SwingReversalState, number> = { "bull-triggered": 0, "bull-inprogress": 0, "bear-triggered": 0, "bear-inprogress": 0 };
    const sg: Record<SwingSubStage, number> = { "1A": 0, "1B": 0, "2A": 0, "2B": 0, "3A": 0, "3B": 0, "4A": 0, "4B": 0 };
    let breakouts = 0, revNone = 0, stageNone = 0;
    for (const r of rows) {
      st[r.ma?.stack ?? "n/a"] += 1;
      if (r.reversal?.state) rv[r.reversal.state] += 1; else revNone++;
      if (r.stage?.subStage) sg[r.stage.subStage] += 1; else stageNone++;
      if (r.stage?.breakout) breakouts++;
    }
    return { st, rv, sg, breakouts, revNone, stageNone };
  }, [rows]);

  const tri = (v: Tri, actual: boolean | null | undefined) => v === "" || (actual !== null && actual !== undefined && actual === (v === "y"));
  const stackSet = selStack.set, revSet = selRev.set, stageSet = selStage.set;
  const filtered = useMemo(() => rows.filter((r) =>
    (stackSet.size === 0 || stackSet.has(r.ma?.stack ?? "n/a"))
    && (revSet.size === 0 || (!!r.reversal?.state && revSet.has(r.reversal.state)))
    && (stageSet.size === 0 || (!!r.stage?.subStage && stageSet.has(r.stage.subStage)))
    && (!breakoutOnly || !!r.stage?.breakout)
    && (!fSector || r.sector === fSector) && (!fIndustry || r.industry === fIndustry)
    && (!q || r.ticker.includes(q.toUpperCase()) || r.company.toUpperCase().includes(q.toUpperCase()))
    && tri(f1, r.ma?.c10over20) && tri(f2, r.ma?.c20over50) && tri(f3, r.ma?.c50over200)
    && tri(fP50, r.ma?.d50 === null || r.ma?.d50 === undefined ? null : r.ma.d50 > 0)
    && tri(fP200, r.ma?.d200 === null || r.ma?.d200 === undefined ? null : r.ma.d200 > 0)
    && tri(fLeg, r.reversal?.legUp)
    && (minScore === 0 || (r.ma?.score ?? -1) >= minScore)),
    [rows, stackSet, revSet, stageSet, breakoutOnly, fSector, fIndustry, q, f1, f2, f3, fP50, fP200, fLeg, minScore]);
  const { rows: sorted, sortKey, sortDir, onSort } = useTableSort<SwingRow, SortKey>(filtered, sortValue, "open", "desc");

  const isDefault = stackSet.size === 1 && stackSet.has("bull")
    && revSet.size === 2 && revSet.has("bull-triggered") && revSet.has("bull-inprogress")
    && stageSet.size === 2 && stageSet.has("2A") && stageSet.has("2B") && !breakoutOnly;
  const moreActive = !!(f1 || f2 || f3 || fP50 || fP200 || fLeg || minScore > 0);
  const resetAll = () => {
    selStack.reset(DEFAULT_STACK); selRev.reset(DEFAULT_REV); selStage.reset(DEFAULT_STAGE); setBreakoutOnly(false);
    setFSector(""); setFIndustry(""); setQ(""); setF1(""); setF2(""); setF3(""); setFP50(""); setFP200(""); setFLeg(""); setMinScore(0);
  };
  const clearLenses = () => { selStack.reset([]); selRev.reset([]); selStage.reset([]); setBreakoutOnly(false); };

  const onUpload = async () => {
    if (!csv.trim()) return;
    setBusy("upload"); setNotice(null);
    try {
      const r = await uploadSwingUniverse(csv);
      setNotice(`List replaced: ${r.count} tickers (${r.added} new, ${r.removed} removed, ${r.skipped} rows skipped). Run the scan to score them.`);
      setCsv(""); setShowUpload(false);
      setUniverseCount(r.count); setUniverseAt(new Date().toISOString());
    } catch (e) { setNotice(e instanceof Error ? e.message : "upload failed"); }
    finally { setBusy(""); }
  };
  const onScan = async () => {
    setBusy("scan"); setNotice(null);
    try {
      const r = await runSwingScan();
      setNotice(`Scored ${r.scored} of ${r.count} for ${r.date}${r.failed ? ` · ${r.failed} failed` : ""}.`);
      setDate(null); await load(null);
    } catch (e) { setNotice(e instanceof Error ? e.message : "scan failed"); }
    finally { setBusy(""); }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Swing Strength</h1>
          <p className="text-xs text-text-secondary">
            A fixed list of {universeCount ?? "…"} stocks, each read against three lenses. Not a scanner.
            {data && <span className="ml-2 text-dim">snapshot {data.date} · scored {fmtTimePT(data.generatedAt)} {PT_LABEL} · {data.scored}/{data.count}</span>}
            {universeAt && <span className="ml-2 text-dim">· list updated {fmtTimePT(universeAt)} {PT_LABEL}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {data?.dates && data.dates.length > 0 && (
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-secondary">
              day
              <select value={date ?? data.date} onChange={(e) => setDate(e.target.value === data.dates[data.dates.length - 1] ? null : e.target.value)}
                className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary">
                {[...data.dates].reverse().map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
          <button onClick={() => setShowGroups((v) => !v)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border ${showGroups ? "bg-text-primary text-bg-primary border-text-primary" : "border-border text-text-secondary hover:text-text-primary"}`}>
            groups
          </button>
          <button onClick={() => setShowUpload((v) => !v)}
            className="px-2.5 py-1 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary">
            {showUpload ? "close upload" : "replace list"}
          </button>
          <button onClick={onScan} disabled={busy !== ""}
            title="Re-score every name now with the latest daily bars (the cron does this at 5:00 PM ET)"
            className="px-2.5 py-1 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary disabled:opacity-40">
            {busy === "scan" ? "scoring…" : "score now"}
          </button>
        </div>
      </div>

      {showUpload && (
        <div className="bg-bg-card border border-border rounded p-3 space-y-2">
          <div className="text-[11px] text-text-secondary">
            Paste a FinViz screener export (CSV, with the header row). This <b className="text-text-primary">replaces</b> the whole list;
            names missing from the export are dropped.
          </div>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} spellCheck={false}
            placeholder={'"No.","Ticker","Company","Sector","Industry","Market Cap",…'}
            className="w-full bg-bg-primary border border-border rounded p-2 text-[11px] font-mono text-text-primary" />
          <div className="flex items-center gap-2">
            <button onClick={onUpload} disabled={busy !== "" || !csv.trim()}
              className="px-3 py-1 rounded-full text-[10px] font-semibold border border-text-primary bg-text-primary text-bg-primary disabled:opacity-40">
              {busy === "upload" ? "replacing…" : "replace the list"}
            </button>
            <span className="text-[10px] text-dim">{csv ? `${csv.split("\n").filter((l) => l.trim()).length - 1} data rows pasted` : ""}</span>
          </div>
        </div>
      )}
      {notice && <div className="text-[11px] text-text-secondary bg-bg-card border border-border rounded px-3 py-2">{notice}</div>}

      {loading && !data && <div className="text-sm text-text-secondary py-8 text-center">Loading…</div>}
      {error && !data && (
        <div className="bg-bg-card border border-border rounded p-4 text-sm text-text-secondary">
          {error}. {universeCount ? "The list is loaded; press “score now” to compute the first snapshot." : "Upload a FinViz export first, then score."}
        </div>
      )}

      {data && (
        <>
          {/* The filter panel: one card, three lens rows, multi-select chips with counts. */}
          <div className="bg-bg-card border border-border rounded px-3 py-2 space-y-1.5">
            <Section title="MA stack">
              {(["bull", "mixed", "bear", "n/a"] as SwingStack[]).map((k) => (
                <Chip key={k} label={STACK_LABEL[k]} count={counts.st[k]} on={selStack.has(k)} tone={STACK_TONE[k]} onToggle={() => selStack.toggle(k)}
                  title={k === "bull" ? "10 > 20 > 50 > 200" : k === "bear" ? "10 < 20 < 50 < 200" : k === "mixed" ? "some inequalities hold" : "under 200 daily bars"} />
              ))}
            </Section>
            <Section title="Reversal">
              {(["bull-triggered", "bull-inprogress", "bear-triggered", "bear-inprogress"] as SwingReversalState[]).map((k) => (
                <Chip key={k} label={STATE_LABEL[k]} count={counts.rv[k]} on={selRev.has(k)} tone={STATE_TONE[k]} onToggle={() => selRev.toggle(k)}
                  title={k.endsWith("triggered") ? "the study's Bullish plot turned within 2 bars" : "turned 2+ bars ago and still there"} />
              ))}
              {counts.revNone > 0 && <span className="text-[10px] text-dim">· {counts.revNone} without a read</span>}
            </Section>
            <Section title="Stage"
              right={
                <div className="flex items-center gap-2 text-[10px]">
                  <button onClick={resetAll} disabled={isDefault && !fSector && !fIndustry && !q && !moreActive}
                    className="px-2 py-0.5 rounded-full border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
                    title="Bull stack ∧ bullish reversal ∧ Stage 2, sorted by change from open">
                    default view
                  </button>
                  <button onClick={clearLenses} className="text-text-secondary hover:text-text-primary underline">show all</button>
                </div>
              }>
              {(["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B"] as SwingSubStage[]).map((k) => (
                <Chip key={k} label={`${k} ${STAGE_NAME[k]}`} count={counts.sg[k]} on={selStage.has(k)} tone={STAGE_TONE[k]} onToggle={() => selStage.toggle(k)} />
              ))}
              <span className="w-px h-4 bg-border mx-0.5" />
              <Chip label="Breakout" count={counts.breakouts} on={breakoutOnly} tone="text-signal-bull" onToggle={() => setBreakoutOnly((v) => !v)}
                title="Stage 2 close ≥ prior 52-week high on ≥ 1.5× 20-week volume, this week or last" />
              {counts.stageNone > 0 && <span className="text-[10px] text-dim">· {counts.stageNone} under 34 weeks</span>}
            </Section>
            <div className="flex items-center gap-2 flex-wrap text-[11px] pt-1 border-t border-border/60">
              <select value={fSector} onChange={(e) => { setFSector(e.target.value); setFIndustry(""); }} className="bg-bg-primary border border-border rounded px-2 py-0.5 text-text-primary">
                <option value="">All sectors</option>
                {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={fIndustry} onChange={(e) => setFIndustry(e.target.value)} className="bg-bg-primary border border-border rounded px-2 py-0.5 text-text-primary">
                <option value="">All industries</option>
                {industries.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ticker or name" className="bg-bg-primary border border-border rounded px-2 py-0.5 text-text-primary w-36" />
              <button onClick={() => setMore((v) => !v)} className={`text-[10px] underline ${moreActive ? "text-text-primary" : "text-text-secondary"} hover:text-text-primary`}>
                {more ? "fewer conditions" : `more conditions${moreActive ? " (active)" : ""}`}
              </button>
              <span className="flex-1" />
              <span className="text-text-secondary tabular-nums"><b className="text-text-primary">{sorted.length}</b> of {rows.length} shown</span>
            </div>
            {more && (
              <div className="flex items-center gap-1.5 flex-wrap text-[10px] pt-1">
                <TriChip label="10 > 20" value={f1} onChange={setF1} title="10 EMA above 20 EMA" />
                <TriChip label="20 > 50" value={f2} onChange={setF2} title="20 EMA above 50 SMA" />
                <TriChip label="50 > 200" value={f3} onChange={setF3} title="50 SMA above 200 SMA" />
                <span className="w-px h-4 bg-border mx-1" />
                <TriChip label="price vs 50" value={fP50} onChange={setFP50} yes="above" no="below" />
                <TriChip label="price vs 200" value={fP200} onChange={setFP200} yes="above" no="below" />
                <TriChip label="leg" value={fLeg} onChange={setFLeg} yes="up" no="down" title="ZigZag leg direction" />
                <span className="w-px h-4 bg-border mx-1" />
                <label className="flex items-center gap-1 text-text-secondary">
                  score ≥
                  <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="bg-bg-primary border border-border rounded px-1 py-0.5 text-[10px] text-text-primary">
                    {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? "any" : `${n}/3`}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>

          {showGroups && (
            <SwingGroups rows={rows} level={groupLevel} onLevel={setGroupLevel}
              activeKey={groupLevel === "sector" ? fSector : fIndustry}
              onPick={(key) => {
                if (groupLevel === "sector") { setFSector(fSector === key ? "" : key); setFIndustry(""); }
                else {
                  const next = fIndustry === key ? "" : key;
                  setFIndustry(next);
                  setFSector(next ? (rows.find((r) => r.industry === next)?.sector ?? "") : "");
                }
                document.getElementById("swing-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }} />
          )}

          <div id="swing-table" className="bg-bg-card border border-border rounded overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <SortHeaderRow columns={COLUMNS} sortKey={sortKey} sortDir={sortDir} onSort={onSort}
                  rowClass="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border"
                  cellClass="px-2 py-1.5 font-semibold whitespace-nowrap" />
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr><td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-text-secondary">No stock matches every selected condition. Untick a chip, or press “show all”.</td></tr>
                )}
                {sorted.map((r) => (
                  <tr key={r.ticker} className="border-b border-border/40 last:border-b-0 hover:bg-bg-secondary/40">
                    <td className="px-2 py-1 font-semibold whitespace-nowrap">
                      <a href={tvUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title={`${r.company} — open in TradingView`}
                        className="hover:underline text-text-primary">{r.ticker}</a>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-text-secondary">{r.sector}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-text-secondary max-w-[12rem] truncate" title={r.industry}>{r.industry}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{fmtCap(r.marketCapM)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.px ? r.px.last.toFixed(2) : r.ma ? r.ma.close.toFixed(2) : <span className="text-signal-bear" title={r.error}>—</span>}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.px?.changePct)}`}>{fmtPct(r.px?.changePct, 2)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums font-semibold ${pctTone(r.px?.fromOpenPct)}`}>{fmtPct(r.px?.fromOpenPct, 2)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.px?.weekPct)}`}>{fmtPct(r.px?.weekPct, 1)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d10)}`} title={r.ma?.ema10 ? `10 EMA ${r.ma.ema10}` : ""}>{fmtPct(r.ma?.d10)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d20)}`} title={r.ma?.ema20 ? `20 EMA ${r.ma.ema20}` : ""}>{fmtPct(r.ma?.d20)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d50)}`} title={r.ma?.sma50 ? `50 SMA ${r.ma.sma50}` : ""}>{fmtPct(r.ma?.d50)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d200)}`} title={r.ma?.sma200 ? `200 SMA ${r.ma.sma200}` : ""}>{fmtPct(r.ma?.d200)}</td>
                    <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                      <Check v={r.ma?.c10over20} /> <Check v={r.ma?.c20over50} /> <Check v={r.ma?.c50over200} />
                      <span className="ml-2 text-text-secondary">{r.ma ? `${r.ma.score}/3` : ""}</span>
                    </td>
                    <td className={`px-2 py-1 whitespace-nowrap font-semibold ${r.ma ? STACK_TONE[r.ma.stack] : "text-signal-bear"}`}>{r.ma ? STACK_LABEL[r.ma.stack] : (r.error ?? "error")}</td>
                    <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                      title={r.reversal ? `leg from ${r.reversal.legFrom ?? "—"} to ${r.reversal.legExtreme ?? "—"} · flips on a ${r.reversal.thresholdPct ?? "—"}% reversal` : ""}>
                      {r.reversal?.legUp === true ? <span className="text-signal-bull">↑ {r.reversal.legBars}b</span>
                        : r.reversal?.legUp === false ? <span className="text-signal-bear">↓ {r.reversal.legBars}b</span>
                        : <span className="text-dim">—</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap text-text-secondary">
                      {r.reversal?.fullK !== null && r.reversal?.fullK !== undefined ? `${r.reversal.fullK.toFixed(0)} / ${(r.reversal.fullD ?? 0).toFixed(0)}` : "—"}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums ${r.reversal?.goingUpBarsAgo !== null && r.reversal?.goingUpBarsAgo !== undefined && r.reversal.goingUpBarsAgo < 7 ? "text-signal-bull font-semibold" : "text-text-secondary"}`}>
                      {r.reversal?.goingUpBarsAgo === null || r.reversal?.goingUpBarsAgo === undefined ? "—" : r.reversal.goingUpBarsAgo === 0 ? "today" : `${r.reversal.goingUpBarsAgo}b ago`}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums ${r.reversal?.goingDownBarsAgo !== null && r.reversal?.goingDownBarsAgo !== undefined && r.reversal.goingDownBarsAgo < 7 ? "text-signal-bear font-semibold" : "text-text-secondary"}`}>
                      {r.reversal?.goingDownBarsAgo === null || r.reversal?.goingDownBarsAgo === undefined ? "—" : r.reversal.goingDownBarsAgo === 0 ? "today" : `${r.reversal.goingDownBarsAgo}b ago`}
                    </td>
                    <td className={`px-2 py-1 whitespace-nowrap font-semibold ${r.reversal?.state ? STATE_TONE[r.reversal.state] : "text-dim"}`}
                      title={r.reversal?.turnBarsAgo !== null && r.reversal?.turnBarsAgo !== undefined ? `Bullish plot turned ${r.reversal.turnBarsAgo === 0 ? "today" : `${r.reversal.turnBarsAgo} bars ago`}` : ""}>
                      {r.reversal?.state ? STATE_LABEL[r.reversal.state] : "—"}
                      {r.reversal?.turnBarsAgo !== null && r.reversal?.turnBarsAgo !== undefined && (
                        <span className="ml-1 font-normal text-dim">{r.reversal.turnBarsAgo === 0 ? "today" : `${r.reversal.turnBarsAgo}b`}</span>
                      )}
                    </td>
                    <td className={`px-2 py-1 whitespace-nowrap font-semibold ${r.stage?.subStage ? STAGE_TONE[r.stage.subStage] : "text-dim"}`}
                      title={r.stage ? `${r.stage.subStage ? STAGE_NAME[r.stage.subStage] : ""} · ${r.stage.why}${r.stage.weekComplete ? "" : " · week in progress"}` : ""}>
                      {r.stage?.subStage ?? (r.stage ? <span className="text-dim" title={r.stage.why}>n/a</span> : "—")}
                      {r.stage?.breakout && <span className="ml-1 text-[9px] uppercase tracking-wider text-signal-bull">brk</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{r.stage?.weeksInStage ?? "—"}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.stage?.distPct)}`} title={r.stage?.sma30 ? `30-wk SMA ${r.stage.sma30}` : ""}>{fmtPct(r.stage?.distPct)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.stage?.slope4wPct)}`}>{fmtPct(r.stage?.slope4wPct)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.stage?.mrs)}`}>{r.stage?.mrs === null || r.stage?.mrs === undefined ? "—" : (() => { const v = Math.round(r.stage!.mrs!); return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0"; })()}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${(r.stage?.rvol ?? 0) >= 1.5 ? "text-text-primary font-semibold" : "text-text-secondary"}`}>{r.stage?.rvol === null || r.stage?.rvol === undefined ? "—" : `${r.stage.rvol.toFixed(1)}×`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-dim">
            Daily closes from Polygon (adjusted), two years; Last / % Chg / From open / Week are end-of-day from the same bars. 10/20 are exponential, 50/200 simple.
            Reversal columns are the operator&apos;s ThinkOrSwim &ldquo;Jonesy Signals&rdquo; study ported as written; the state is its Bullish plot (a turn detector on the
            ZigZagHighLow&apos;s running extreme, EMA5 highs/lows, 1% + 2×ATR(5) + $0.05): <b>triggered</b> = turned within 2 bars, the operator&apos;s scan; <b>in progress</b> = older.
            Stage is Weinstein on weekly bars: 30-week SMA, 4-week slope (flat = ±0.5%), Mansfield RS vs SPY; 1B = 8+ weeks of base, range ≤ 20%, MRS &gt; −1; 2B = &gt; 15% over or &gt; 16 weeks;
            3B = MRS &lt; 0; 4B = &gt; 16 weeks or &gt; 15% under; a flat SMA is Stage 1 after a falling slope, Stage 3 after a rising one. Snapshots are stored per trading day and never overwritten.
          </p>
        </>
      )}
    </div>
  );
}
