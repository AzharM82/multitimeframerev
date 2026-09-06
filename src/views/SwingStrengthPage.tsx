import { useCallback, useEffect, useMemo, useState } from "react";
import type { SwingResultsResponse, SwingRow, SwingStack } from "../types.js";
import { getSwingResults, getSwingUniverse, uploadSwingUniverse, runSwingScan } from "../services/api.js";
import { useTableSort, SortHeaderRow, type SortColumn } from "./shared/tableSort.js";
import { fmtTimePT, PT_LABEL } from "../utils/time.js";

/**
 * Swing Strength — a FIXED list of stocks, each shown against three lenses.
 *
 * Not a scanner. The operator curates the list in FinViz and pastes the export
 * here; a nightly scan then scores every name so the same stocks can be watched
 * moving between states day after day.
 *
 *   Lens 1  MA stack, daily: 10 EMA > 20 EMA > 50 SMA > 200 SMA  (Phase 1, live)
 *   Lens 2  Bullish / bearish reversal — the operator's ThinkOrSwim script (Phase 2)
 *   Lens 3  Weinstein stage, weekly (Phase 3)
 *
 * Group rollups by sector and industry land in Phase 4. The view performs no
 * indicator arithmetic: every level, distance and flag comes from the API.
 */

type SortKey = "ticker" | "sector" | "industry" | "close" | "d10" | "d20" | "d50" | "d200" | "score" | "stack" | "mcap"
  | "leg" | "stoch" | "revUp" | "revDown" | "signal";

const COLUMNS: SortColumn<SortKey>[] = [
  { key: "ticker", label: "Ticker", num: false },
  { key: "sector", label: "Sector", num: false },
  { key: "industry", label: "Industry", num: false },
  { key: "mcap", label: "Mkt cap", num: true, title: "FinViz market cap, $ billions" },
  { key: "close", label: "Close", num: true },
  { key: "d10", label: "vs 10 EMA", num: true, title: "% distance of price from the 10-day EMA" },
  { key: "d20", label: "vs 20 EMA", num: true, title: "% distance of price from the 20-day EMA" },
  { key: "d50", label: "vs 50 SMA", num: true, title: "% distance of price from the 50-day SMA" },
  { key: "d200", label: "vs 200 SMA", num: true, title: "% distance of price from the 200-day SMA" },
  { key: "score", label: "10>20 · 20>50 · 50>200", num: true, title: "The three inequalities of the stack" },
  { key: "stack", label: "Stack", num: false },
  { key: "leg", label: "Leg", num: true, title: "ZigZag leg direction (the TOS study's Bullish plot) and bars since it began" },
  { key: "stoch", label: "K / D", num: true, title: "StochasticFull 8·12·3 — FullK and FullD on the last bar" },
  { key: "revUp", label: "Bull rev", num: true, title: "Bars since Going_Up last fired (K crossed above D from under 40). 0 = today" },
  { key: "revDown", label: "Bear rev", num: true, title: "Bars since Going_Down last fired (D crossed above K from over 75). 0 = today" },
  { key: "signal", label: "Reversal", num: false, title: "The more recent cross, if inside the window" },
];

const STACK_LABEL: Record<SwingStack, string> = { bull: "Bull stack", bear: "Bear stack", mixed: "Mixed", "n/a": "Not enough bars" };
const STACK_TONE: Record<SwingStack, string> = { bull: "text-signal-bull", bear: "text-signal-bear", mixed: "text-text-secondary", "n/a": "text-dim" };

const fmtPct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}%`;
const pctTone = (v: number | null | undefined) =>
  v === null || v === undefined ? "text-dim" : v > 0 ? "text-signal-bull" : v < 0 ? "text-signal-bear" : "text-text-secondary";
const fmtCap = (m: number | null) => (m === null ? "—" : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}B` : `${m.toFixed(0)}M`);

function sortValue(r: SwingRow, key: SortKey): number | string | null {
  switch (key) {
    case "ticker": return r.ticker;
    case "sector": return r.sector;
    case "industry": return r.industry;
    case "mcap": return r.marketCapM;
    case "close": return r.ma?.close ?? null;
    case "d10": return r.ma?.d10 ?? null;
    case "d20": return r.ma?.d20 ?? null;
    case "d50": return r.ma?.d50 ?? null;
    case "d200": return r.ma?.d200 ?? null;
    case "score": return r.ma?.score ?? null;
    case "stack": return r.ma?.stack ?? "zzz";
    case "leg": return r.reversal?.legUp === null || r.reversal?.legUp === undefined ? null : (r.reversal.legUp ? 1 : -1) * (r.reversal.legBars ?? 0);
    case "stoch": return r.reversal?.fullK ?? null;
    // bars-ago sorts ascending-first would be nicer, but the shared hook sorts numeric desc-first; negate so "freshest first" is the default.
    case "revUp": return r.reversal?.goingUpBarsAgo === null || r.reversal?.goingUpBarsAgo === undefined ? null : -r.reversal.goingUpBarsAgo;
    case "revDown": return r.reversal?.goingDownBarsAgo === null || r.reversal?.goingDownBarsAgo === undefined ? null : -r.reversal.goingDownBarsAgo;
    case "signal": return r.reversal?.signal ?? "zzz";
  }
}

function Check({ v }: { v: boolean | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-dim">·</span>;
  return <span className={v ? "text-signal-bull" : "text-signal-bear"}>{v ? "✓" : "✗"}</span>;
}

type Tri = "" | "y" | "n";

/** A three-state filter chip: any → ✓ only → ✗ only → any. */
function TriChip({ label, value, onChange, yes = "✓", no = "✗", title }: {
  label: string; value: Tri; onChange: (v: Tri) => void; yes?: string; no?: string; title?: string;
}) {
  const next: Record<Tri, Tri> = { "": "y", y: "n", n: "" };
  const cls = value === "y" ? "border-signal-bull text-signal-bull bg-bg-card" : value === "n" ? "border-signal-bear text-signal-bear bg-bg-card" : "border-border text-text-secondary hover:text-text-primary";
  return (
    <button onClick={() => onChange(next[value])} title={title ?? `${label}: click to cycle any → ${yes} → ${no}`}
      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors ${cls}`}>
      {label} <span className="ml-1">{value === "y" ? yes : value === "n" ? no : "any"}</span>
    </button>
  );
}

function Tile({ label, value, sub, cls, onClick, active }: { label: string; value: string; sub?: string; cls?: string; onClick?: () => void; active?: boolean }) {
  const inner = (
    <>
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${cls ?? "text-text-primary"}`}>{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </>
  );
  const base = `bg-bg-card border rounded px-3 py-2 text-left ${active ? "border-text-primary" : "border-border"}`;
  return onClick ? <button onClick={onClick} className={`${base} hover:bg-bg-secondary/60`}>{inner}</button> : <div className={base}>{inner}</div>;
}

export function SwingStrengthPage() {
  const [data, setData] = useState<SwingResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState<string | null>(null);
  const [universeCount, setUniverseCount] = useState<number | null>(null);
  const [universeAt, setUniverseAt] = useState<string | null>(null);
  const [fSector, setFSector] = useState<string>("");
  const [fIndustry, setFIndustry] = useState<string>("");
  const [fStack, setFStack] = useState<SwingStack | "">("");
  const [q, setQ] = useState("");
  /** Condition filters that sit on top of the table. Each is any / ✓ / ✗. */
  const [f1, setF1] = useState<Tri>("");      // 10 EMA > 20 EMA
  const [f2, setF2] = useState<Tri>("");      // 20 EMA > 50 SMA
  const [f3, setF3] = useState<Tri>("");      // 50 SMA > 200 SMA
  const [fP50, setFP50] = useState<Tri>("");  // price above 50 SMA
  const [fP200, setFP200] = useState<Tri>(""); // price above 200 SMA
  const [minScore, setMinScore] = useState<number>(0);
  const [fSignal, setFSignal] = useState<"" | "bull" | "bear" | "none">("");
  const [fLeg, setFLeg] = useState<Tri>("");   // ZigZag leg up (✓) / down (✗)
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
  const tri = (v: Tri, actual: boolean | null | undefined) => v === "" || (actual !== null && actual !== undefined && actual === (v === "y"));
  const filtered = useMemo(() => rows.filter((r) =>
    (!fSector || r.sector === fSector) && (!fIndustry || r.industry === fIndustry)
    && (!fStack || r.ma?.stack === fStack)
    && (!q || r.ticker.includes(q.toUpperCase()) || r.company.toUpperCase().includes(q.toUpperCase()))
    && tri(f1, r.ma?.c10over20) && tri(f2, r.ma?.c20over50) && tri(f3, r.ma?.c50over200)
    && tri(fP50, r.ma?.d50 === null || r.ma?.d50 === undefined ? null : r.ma.d50 > 0)
    && tri(fP200, r.ma?.d200 === null || r.ma?.d200 === undefined ? null : r.ma.d200 > 0)
    && (minScore === 0 || (r.ma?.score ?? -1) >= minScore)
    && (!fSignal || (fSignal === "none" ? !r.reversal?.signal : r.reversal?.signal === fSignal))
    && tri(fLeg, r.reversal?.legUp)),
    [rows, fSector, fIndustry, fStack, q, f1, f2, f3, fP50, fP200, minScore, fSignal, fLeg]);
  const anyCondition = f1 || f2 || f3 || fP50 || fP200 || minScore > 0 || fSignal || fLeg;
  const clearConditions = () => { setF1(""); setF2(""); setF3(""); setFP50(""); setFP200(""); setMinScore(0); setFSignal(""); setFLeg(""); };
  const { rows: sorted, sortKey, sortDir, onSort } = useTableSort<SwingRow, SortKey>(filtered, sortValue, "score", "desc");

  const counts = useMemo(() => {
    const c: Record<SwingStack | "error", number> = { bull: 0, bear: 0, mixed: 0, "n/a": 0, error: 0 };
    for (const r of rows) c[r.ma?.stack ?? "error"] += 1;
    return c;
  }, [rows]);
  const revCounts = useMemo(() => {
    const c = { bull: 0, bear: 0, none: 0, legUp: 0, legDown: 0 };
    for (const r of rows) {
      const sig = r.reversal?.signal ?? null;
      if (sig === "bull") c.bull++; else if (sig === "bear") c.bear++; else c.none++;
      if (r.reversal?.legUp === true) c.legUp++; else if (r.reversal?.legUp === false) c.legDown++;
    }
    return c;
  }, [rows]);
  const hasLens2 = rows.some((r) => r.reversal);

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
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Swing Strength</h1>
          <p className="text-xs text-text-secondary">
            A fixed list of {universeCount ?? "…"} stocks, each read against three lenses. Not a scanner — the list only changes when you upload a new FinViz export.
            {universeAt && <span className="ml-2 text-dim">list updated {fmtTimePT(universeAt)} {PT_LABEL}</span>}
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
            names missing from the export are dropped. Ticker, Company, Sector, Industry and Market Cap are read by column name; other numeric columns are kept as extras.
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Tile label="Bull stack" value={`${counts.bull}`} sub="10 > 20 > 50 > 200" cls="text-signal-bull" onClick={() => setFStack(fStack === "bull" ? "" : "bull")} active={fStack === "bull"} />
            <Tile label="Mixed" value={`${counts.mixed}`} sub="some inequalities hold" onClick={() => setFStack(fStack === "mixed" ? "" : "mixed")} active={fStack === "mixed"} />
            <Tile label="Bear stack" value={`${counts.bear}`} sub="10 < 20 < 50 < 200" cls="text-signal-bear" onClick={() => setFStack(fStack === "bear" ? "" : "bear")} active={fStack === "bear"} />
            <Tile label="Not enough history" value={`${counts["n/a"] + counts.error}`} sub={counts.error ? `${counts.error} failed to load` : "under 200 daily bars"} cls="text-dim" onClick={() => setFStack(fStack === "n/a" ? "" : "n/a")} active={fStack === "n/a"} />
            <Tile label="Snapshot" value={data.date} sub={`scored ${fmtTimePT(data.generatedAt)} ${PT_LABEL} · ${data.scored}/${data.count}`} />
          </div>
          {hasLens2 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Tile label="Bullish reversal" value={`${revCounts.bull}`} sub="Going_Up fired within 7 bars" cls="text-signal-bull"
                onClick={() => setFSignal(fSignal === "bull" ? "" : "bull")} active={fSignal === "bull"} />
              <Tile label="Bearish reversal" value={`${revCounts.bear}`} sub="Going_Down fired within 7 bars" cls="text-signal-bear"
                onClick={() => setFSignal(fSignal === "bear" ? "" : "bear")} active={fSignal === "bear"} />
              <Tile label="No fresh cross" value={`${revCounts.none}`} sub="neither in the window"
                onClick={() => setFSignal(fSignal === "none" ? "" : "none")} active={fSignal === "none"} />
              <Tile label="Leg up" value={`${revCounts.legUp}`} sub="ZigZag leg rising (TOS “Bullish”)" cls="text-signal-bull"
                onClick={() => setFLeg(fLeg === "y" ? "" : "y")} active={fLeg === "y"} />
              <Tile label="Leg down" value={`${revCounts.legDown}`} sub="ZigZag leg falling" cls="text-signal-bear"
                onClick={() => setFLeg(fLeg === "n" ? "" : "n")} active={fLeg === "n"} />
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <select value={fSector} onChange={(e) => { setFSector(e.target.value); setFIndustry(""); }} className="bg-bg-primary border border-border rounded px-2 py-1 text-text-primary">
              <option value="">All sectors</option>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={fIndustry} onChange={(e) => setFIndustry(e.target.value)} className="bg-bg-primary border border-border rounded px-2 py-1 text-text-primary">
              <option value="">All industries</option>
              {industries.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ticker or name" className="bg-bg-primary border border-border rounded px-2 py-1 text-text-primary w-40" />
            <span className="text-dim">{sorted.length} of {rows.length}</span>
            {(fSector || fIndustry || fStack || q || anyCondition) && (
              <button onClick={() => { setFSector(""); setFIndustry(""); setFStack(""); setQ(""); clearConditions(); }} className="text-text-secondary hover:text-text-primary underline">clear all</button>
            )}
            <span className="flex-1" />
            <span className="text-dim">{hasLens2 ? "Lens 3 (Weinstein stage) arrives in the next phase." : "Lens 2 (reversal) and Lens 3 (Weinstein stage) arrive in the next phases."}</span>
          </div>

          <div className="bg-bg-card border border-border rounded">
            <div className="flex items-center gap-1.5 flex-wrap px-2 py-1.5 border-b border-border text-[10px]">
              <span className="uppercase tracking-wider text-text-secondary mr-1">Conditions</span>
              <TriChip label="10 > 20" value={f1} onChange={setF1} title="10 EMA above 20 EMA" />
              <TriChip label="20 > 50" value={f2} onChange={setF2} title="20 EMA above 50 SMA" />
              <TriChip label="50 > 200" value={f3} onChange={setF3} title="50 SMA above 200 SMA" />
              <span className="w-px h-4 bg-border mx-1" />
              <TriChip label="price vs 50" value={fP50} onChange={setFP50} yes="above" no="below" title="Price above or below the 50 SMA" />
              <TriChip label="price vs 200" value={fP200} onChange={setFP200} yes="above" no="below" title="Price above or below the 200 SMA" />
              <span className="w-px h-4 bg-border mx-1" />
              <TriChip label="leg" value={fLeg} onChange={setFLeg} yes="up" no="down" title="ZigZag leg direction (the study's Bullish plot)" />
              <select value={fSignal} onChange={(e) => setFSignal(e.target.value as "" | "bull" | "bear" | "none")}
                className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary" title="Reversal badge">
                <option value="">reversal: any</option>
                <option value="bull">bullish reversal</option>
                <option value="bear">bearish reversal</option>
                <option value="none">no fresh cross</option>
              </select>
              <span className="w-px h-4 bg-border mx-1" />
              <label className="flex items-center gap-1 text-text-secondary">
                score ≥
                <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="bg-bg-primary border border-border rounded px-1 py-0.5 text-[10px] text-text-primary">
                  {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? "any" : `${n}/3`}</option>)}
                </select>
              </label>
              <span className="flex-1" />
              <span className="text-text-secondary tabular-nums">{sorted.length} shown</span>
              {anyCondition && <button onClick={clearConditions} className="text-text-secondary hover:text-text-primary underline">reset conditions</button>}
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <SortHeaderRow columns={COLUMNS} sortKey={sortKey} sortDir={sortDir} onSort={onSort}
                  rowClass="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border"
                  cellClass="px-2 py-1.5 font-semibold whitespace-nowrap" />
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.ticker} className="border-b border-border/40 last:border-b-0 hover:bg-bg-secondary/40">
                    <td className="px-2 py-1 font-semibold whitespace-nowrap" title={r.company}>{r.ticker}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-text-secondary">{r.sector}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-text-secondary max-w-[14rem] truncate" title={r.industry}>{r.industry}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{fmtCap(r.marketCapM)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.ma ? r.ma.close.toFixed(2) : <span className="text-signal-bear" title={r.error}>—</span>}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d10)}`} title={r.ma?.ema10 ? `10 EMA ${r.ma.ema10}` : ""}>{fmtPct(r.ma?.d10)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d20)}`} title={r.ma?.ema20 ? `20 EMA ${r.ma.ema20}` : ""}>{fmtPct(r.ma?.d20)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d50)}`} title={r.ma?.sma50 ? `50 SMA ${r.ma.sma50}` : ""}>{fmtPct(r.ma?.d50)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctTone(r.ma?.d200)}`} title={r.ma?.sma200 ? `200 SMA ${r.ma.sma200}` : ""}>{fmtPct(r.ma?.d200)}</td>
                    <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                      <Check v={r.ma?.c10over20} /> <Check v={r.ma?.c20over50} /> <Check v={r.ma?.c50over200} />
                      <span className="ml-2 text-text-secondary">{r.ma ? `${r.ma.score}/3` : ""}</span>
                    </td>
                    <td className={`px-2 py-1 whitespace-nowrap font-semibold ${r.ma ? STACK_TONE[r.ma.stack] : "text-signal-bear"}`}>
                      {r.ma ? STACK_LABEL[r.ma.stack] : (r.error ?? "error")}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                      title={r.reversal ? `leg from ${r.reversal.legFrom ?? "—"} to ${r.reversal.legExtreme ?? "—"} · flips on a ${r.reversal.thresholdPct ?? "—"}% reversal of EMA5 high/low` : ""}>
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
                    <td className={`px-2 py-1 whitespace-nowrap font-semibold ${r.reversal?.signal === "bull" ? "text-signal-bull" : r.reversal?.signal === "bear" ? "text-signal-bear" : "text-dim"}`}>
                      {r.reversal?.signal === "bull" ? "Bullish" : r.reversal?.signal === "bear" ? "Bearish" : r.reversal ? "·" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <p className="text-[10px] text-dim">
            Daily closes from Polygon (adjusted), two years. 10/20 are exponential, 50/200 simple. Distances are price vs the average.
            Reversal columns are the operator&apos;s ThinkOrSwim &ldquo;Jonesy Signals&rdquo; study ported as written: Leg is the ZigZagHighLow direction on EMA5 highs/lows
            (1% + 2×ATR(5) + $0.05 reversal), K / D is StochasticFull 8·12·3, Bull rev / Bear rev are bars since Going_Up / Going_Down last fired, and the Reversal badge is the more
            recent of the two if it fired within 7 bars. Snapshots are stored per trading day and never overwritten by a later day.
          </p>
        </>
      )}
    </div>
  );
}
