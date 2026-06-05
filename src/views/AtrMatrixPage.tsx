import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AtrStock, AtrScanResponse, AtrLookupResponse, AtrZone, AtrAction, AtrPosition, BreadthResponse, BreadthStats, Posture } from "../types.js";
import { getAtrScan, getBreadth, getAtrLookup } from "../services/api.js";

/* ATR Matrix — swing extension scanner. EOD-only: the snapshot is produced once
   after close by atr-eod-timer. Warm "newspaper" theme. Framework credit:
   @SteveDJacobs. */

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t)}`;
const GRADES = ["A+","A","A-","B+","B","B-","C+","C","C-","D+","D","D-","E+","E","E-","F+","F","F-","G+","G","G-"];
const POS_KEY = "atr_positions";

type ViewKey = "extension" | "rts" | "positions";

// Zone styling on the warm/light theme: solid bar + light tint + ink text +
// literal border class (no runtime string-building — Tailwind's JIT can't see
// classes assembled at runtime).
const ZONE: Record<AtrZone, { bar: string; tint: string; text: string; border: string }> = {
  LEAVE:    { bar: "bg-red-700",     tint: "bg-red-50",     text: "text-red-700",     border: "border-red-700" },
  ENTRY:    { bar: "bg-emerald-700", tint: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-700" },
  HOLD:     { bar: "bg-amber-600",   tint: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-600" },
  EXTENDED: { bar: "bg-orange-600",  tint: "bg-orange-50",  text: "text-orange-700",  border: "border-orange-600" },
  BLOWOFF:  { bar: "bg-fuchsia-700", tint: "bg-fuchsia-50", text: "text-fuchsia-700", border: "border-fuchsia-700" },
};
const ACTION_BORDER: Record<AtrAction, string> = {
  buy: "border-emerald-600",
  inflection: "border-orange-500",
  restore: "border-amber-500",
  reduce: "border-sky-600",
  sell: "border-red-600",
  hold: "border-border",
};
const ACTION_LABEL: { key: AtrAction; cls: string }[] = [
  { key: "buy", cls: "text-emerald-700" },
  { key: "reduce", cls: "text-sky-700" },
  { key: "sell", cls: "text-red-700" },
];

function zoneOf(b: number): AtrZone {
  if (b < 0) return "LEAVE";
  if (b <= 4) return "ENTRY";
  if (b <= 6) return "HOLD";
  if (b <= 10) return "EXTENDED";
  return "BLOWOFF";
}
const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

// "Trending candidates" = your original hand-picked screener, re-applied as a
// filter within the broad S&P 500 + Nasdaq 100 universe.
function isCandidate(s: AtrStock): boolean {
  return (
    s.marketCap >= 2e9 &&
    s.close >= 10 &&
    (s.avgVol ?? 0) >= 750_000 &&
    s.atr >= 1.5 &&
    (s.volWeek ?? 0) >= 3 &&
    s.sma20 >= s.sma50 &&
    s.sma50 >= s.sma200
  );
}

// ─── tooltip ────────────────────────────────────────────────────────────────

interface TipState { s: AtrStock; x: number; y: number }

function Tooltip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  const { s } = tip;
  const style: CSSProperties = {
    left: Math.min(tip.x + 14, window.innerWidth - 260),
    top: Math.min(tip.y + 14, window.innerHeight - 230),
  };
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex justify-between gap-4">
      <span className="text-text-secondary">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
  return (
    <div
      className="fixed z-50 w-60 p-3 rounded border border-border bg-bg-card text-xs shadow-lg pointer-events-none space-y-0.5"
      style={style}
    >
      <div className="font-bold text-sm mb-1 truncate">{s.ticker} · <span className="text-text-secondary font-normal">{s.company}</span></div>
      <Row k="close" v={`$${s.close} (${fmtPct(s.chg)})`} />
      <Row k="ATR" v={`$${s.atr} · ${s.atrPct}%`} />
      <Row k="ATR RS" v={`${s.atrRS}`} />
      <Row k="RVOL" v={s.rvol != null ? `${s.rvol}×` : "—"} />
      <Row k="ext now / prev" v={`${s.ext} / ${s.extPrev}`} />
      <Row k="structure" v={`${s.structure}/6 · ${s.grade}`} />
      <Row k="RS pctile" v={`${s.rs}`} />
      <Row k="20d $vol" v={`$${s.dvol}M`} />
      <Row k="suggested stop" v={`$${s.stopSuggest}`} />
      <Row k="action" v={s.action} />
    </div>
  );
}

// ─── chip ───────────────────────────────────────────────────────────────────

function Chip({ s, onHover, onLeave }: { s: AtrStock; onHover: (t: TipState) => void; onLeave: () => void }) {
  return (
    <button
      onClick={() => window.open(TV(s.ticker), "_blank", "noopener")}
      onMouseEnter={(e) => onHover({ s, x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => onHover({ s, x: e.clientX, y: e.clientY })}
      onMouseLeave={onLeave}
      className={`flex items-center justify-between gap-1 w-full px-1.5 py-0.5 rounded border-l-2 border bg-bg-card hover:bg-bg-secondary text-[11px] leading-tight ${ACTION_BORDER[s.action]} ${s.bucket >= 7 ? "font-bold" : ""}`}
    >
      <span className="font-bold truncate">
        {(s.rvol ?? 0) >= 2 && <span title={`RVOL ${s.rvol}×`}>🔥</span>}
        {s.ticker}
      </span>
      <span className={`tabular-nums shrink-0 ${s.chg >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>{fmtPct(s.chg)}</span>
    </button>
  );
}

// ─── market posture (whole-index breadth) ──────────────────────────────────

const POSTURE: Record<Posture, { label: string; cls: string }> = {
  RISK_ON: { label: "RISK-ON", cls: "text-emerald-700 bg-emerald-50 border-emerald-300" },
  MIXED: { label: "MIXED", cls: "text-amber-700 bg-amber-50 border-amber-300" },
  RISK_OFF: { label: "RISK-OFF", cls: "text-red-700 bg-red-50 border-red-300" },
};

function BreadthRow({ label, pct, n, total }: { label: string; pct: number; n: number; total: number }) {
  const bar = pct >= 55 ? "bg-emerald-600" : pct >= 45 ? "bg-amber-500" : "bg-red-600";
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-[11px] mb-0.5">
        <span className="text-text-secondary">{label}</span>
        <span className="tabular-nums font-bold">{pct}% <span className="text-text-secondary font-normal">({n}/{total})</span></span>
      </div>
      <div className="h-1.5 bg-bg-secondary rounded overflow-hidden">
        <div className={`h-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Gauge({ s }: { s: BreadthStats }) {
  return (
    <div className="flex-1 min-w-[260px] bg-bg-card border border-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="section-header text-sm font-bold">{s.label}</span>
        <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wider border rounded ${POSTURE[s.posture].cls}`}>{POSTURE[s.posture].label}</span>
      </div>
      <BreadthRow label="Above 50-day" pct={s.pctAboveSma50} n={s.aboveSma50} total={s.total} />
      <BreadthRow label="Above 200-day" pct={s.pctAboveSma200} n={s.aboveSma200} total={s.total} />
      <div className="flex items-center justify-between text-[11px] mt-2 pt-2 border-t border-border">
        <span><span className="text-signal-bull font-bold">{s.advancers}</span> adv · <span className="text-signal-bear font-bold">{s.decliners}</span> dec</span>
        <span className="text-text-secondary">{s.overbought} OB · {s.oversold} OS</span>
      </div>
    </div>
  );
}

function MarketPosture({ data, error }: { data: BreadthResponse | null; error: string | null }) {
  if (error || (data && data.indices.length === 0)) return null;
  return (
    <div className="space-y-1.5">
      <div className="card-header text-text-secondary">
        Market Posture · whole-index breadth — the "should I be trading?" tone
      </div>
      {!data ? (
        <div className="text-xs text-text-secondary py-2">Loading market posture…</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.indices.map((s) => <Gauge key={s.filter} s={s} />)}
        </div>
      )}
    </div>
  );
}

// ─── stat card ──────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-bg-card border border-border rounded px-3 py-2 min-w-[92px]">
      <div className="card-header text-text-secondary">{label}</div>
      <div className={`text-xl font-bold tabular-nums mt-0.5 ${color ?? ""}`}>{value}</div>
    </div>
  );
}

// ─── reverse-lookup detail card ─────────────────────────────────────────────

function DetailItem({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="bg-bg-secondary rounded px-2 py-1.5">
      <div className="card-header text-text-secondary">{k}</div>
      <div className={`font-bold tabular-nums text-sm mt-0.5 ${cls ?? ""}`}>{v}</div>
    </div>
  );
}

function StockDetail({ res, onClose }: { res: AtrLookupResponse; onClose: () => void }) {
  const s = res.stock;
  const zone = ZONE[s.zone];
  const chgCls = s.chg >= 0 ? "text-signal-bull" : "text-signal-bear";
  return (
    <div className="bg-bg-card border-2 border-accent rounded p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <a href={TV(s.ticker)} target="_blank" rel="noopener" className="text-xl font-black text-accent hover:underline">{s.ticker}</a>
            {(s.rvol ?? 0) >= 2 && <span title={`RVOL ${s.rvol}×`}>🔥</span>}
            <span className={`px-2 py-0.5 text-[10px] font-bold border rounded ${zone.tint} ${zone.text} ${zone.border}`}>{s.zone}</span>
            <span className={`px-2 py-0.5 text-[10px] font-bold uppercase border-l-2 border rounded ${ACTION_BORDER[s.action]}`}>{s.action}</span>
            <span className="px-2 py-0.5 text-[10px] font-bold border border-border rounded">{s.grade}</span>
            {!res.inUniverse && <span className="text-[10px] text-text-secondary">· looked up — not in S&P 500 / Nasdaq 100 (RS &amp; ATR-RS ranked vs that universe)</span>}
          </div>
          <div className="text-xs text-text-secondary mt-1">{s.company} · {s.sector} · {s.industry}</div>
        </div>
        <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg leading-none">✕</button>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 mt-3">
        <DetailItem k="Price" v={`$${s.close}`} />
        <DetailItem k="Change" v={fmtPct(s.chg)} cls={chgCls} />
        <DetailItem k="Extension" v={`${s.ext}x`} cls={zone.text} />
        <DetailItem k="Structure" v={`${s.structure}/6`} />
        <DetailItem k="RS pctile" v={`${s.rs}`} />
        <DetailItem k="ATR RS" v={`${s.atrRS}`} />
        <DetailItem k="RVOL" v={s.rvol != null ? `${s.rvol}×` : "—"} cls={(s.rvol ?? 0) >= 2 ? "text-orange-600" : ""} />
        <DetailItem k="ATR" v={`$${s.atr} · ${s.atrPct}%`} />
        <DetailItem k="20d $vol" v={`$${s.dvol}M`} />
        <DetailItem k="SMA50" v={`$${s.sma50}`} />
        <DetailItem k="Suggested stop" v={`$${s.stopSuggest}`} cls="text-signal-bear" />
        <DetailItem k="Above SMA50" v={s.aboveSMA50 ? "yes" : "no"} cls={s.aboveSMA50 ? "text-signal-bull" : "text-signal-bear"} />
      </div>

      <div className="mt-3">
        <div className="card-header text-text-secondary mb-1">Scale-out ladder · trim levels (ext reaches k×)</div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(s.ladder).map(([k, v]) => (
            <span key={k} className={`px-1.5 py-0.5 text-[11px] rounded border ${s.close >= (v as number) ? "border-emerald-600 text-emerald-700" : "border-border text-text-secondary"}`}>
              {k}x ${v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export function AtrMatrixPage() {
  const [data, setData] = useState<AtrScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewKey>("extension");
  const [search, setSearch] = useState("");
  const [fAtr, setFAtr] = useState(false);
  const [fTrend, setFTrend] = useState(false);
  const [fAction, setFAction] = useState("");
  const [fSector, setFSector] = useState("");
  const [fCandidate, setFCandidate] = useState(false);
  const [fRvol, setFRvol] = useState(false);
  const [isolate, setIsolate] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [positions, setPositions] = useState<AtrPosition[]>([]);
  const [breadth, setBreadth] = useState<BreadthResponse | null>(null);
  const [breadthErr, setBreadthErr] = useState<string | null>(null);
  const [lookup, setLookup] = useState<AtrLookupResponse | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState<"buy" | "sell">("buy");
  const [focusTouched, setFocusTouched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAtrScan()
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getBreadth()
      .then((d) => { if (!cancelled) setBreadth(d); })
      .catch((e: Error) => { if (!cancelled) setBreadthErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try { setPositions(JSON.parse(localStorage.getItem(POS_KEY) || "[]")); } catch { setPositions([]); }
  }, []);
  function savePositions(next: AtrPosition[]) {
    setPositions(next);
    localStorage.setItem(POS_KEY, JSON.stringify(next));
  }

  const stocks = data?.stocks ?? [];

  // Market bias from index breadth → default Focus to buy or sell.
  const marketBias: "buy" | "sell" = useMemo(() => {
    const inds = breadth?.indices ?? [];
    if (!inds.length) return "buy";
    const off = inds.filter((i) => i.posture === "RISK_OFF").length;
    const on = inds.filter((i) => i.posture === "RISK_ON").length;
    return off > on ? "sell" : "buy";
  }, [breadth]);
  useEffect(() => { if (!focusTouched) setFocusMode(marketBias); }, [marketBias, focusTouched]);

  async function doLookup(raw: string) {
    const t = raw.trim().toUpperCase();
    if (!t) return;
    setLookupErr(null);
    const local = stocks.find((s) => s.ticker === t);
    if (local) { setLookup({ stock: local, inUniverse: true }); return; }
    setLookupLoading(true);
    try {
      setLookup(await getAtrLookup(t));
    } catch (e) {
      setLookupErr(e instanceof Error ? e.message : "lookup failed");
      setLookup(null);
    } finally {
      setLookupLoading(false);
    }
  }

  const sectors = useMemo(
    () => [...new Set(stocks.map((s) => s.sector).filter(Boolean))].sort(),
    [stocks],
  );

  const filtered = useMemo(() => {
    let rows = stocks;
    if (search) rows = rows.filter((s) => s.ticker.includes(search.toUpperCase()));
    if (fAtr) rows = rows.filter((s) => s.atrRS >= 50);
    if (fTrend) rows = rows.filter((s) => s.structure >= 5);
    if (fAction) rows = rows.filter((s) => s.action === fAction);
    if (fSector) rows = rows.filter((s) => s.sector === fSector);
    if (fCandidate) rows = rows.filter(isCandidate);
    if (fRvol) rows = rows.filter((s) => (s.rvol ?? 0) >= 1.5);
    return rows;
  }, [stocks, search, fAtr, fTrend, fAction, fSector, fCandidate, fRvol]);

  const focus = useMemo(() => {
    if (focusMode === "sell") {
      // exits / breakdowns — below SMA50, most-broken first
      return stocks.filter((s) => s.action === "sell").sort((a, b) => a.ext - b.ext);
    }
    return stocks
      .filter((s) => s.action === "buy" && s.ext >= 0 && s.ext <= 4 && s.atrRS >= 50)
      .sort((a, b) => a.ext - b.ext);
  }, [stocks, focusMode]);

  const above = filtered.filter((s) => s.aboveSMA50).length;
  const breadthPct = filtered.length ? Math.round((100 * above) / filtered.length) : 0;

  function resetFilters() {
    setSearch(""); setFAtr(false); setFTrend(false); setFAction(""); setFSector(""); setFCandidate(false); setFRvol(false); setIsolate(null);
  }

  const onHover = (t: TipState) => setTip(t);
  const onLeave = () => setTip(null);

  return (
    <div className="space-y-3">
      <Tooltip tip={tip} />

      {/* market posture — whole-index breadth (tone-setter) */}
      <MarketPosture data={breadth} error={breadthErr} />

      {/* header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="card-header text-text-secondary">@SteveDJacobs · Relative Trend Strength</div>
          <h2 className="font-[var(--font-playfair)] text-2xl font-black tracking-tight mt-0.5">ATR Matrix</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Stat label="Universe" value={data?.count ?? "—"} />
          <Stat label="Showing" value={filtered.length} />
          <Stat label="Avg ATR%" value={data ? `${data.avgAtrPct}%` : "—"} />
          <Stat label="Buyable" value={filtered.filter((r) => r.action === "buy").length} color="text-signal-bull" />
          <Stat label="7x+ Ext" value={filtered.filter((r) => r.bucket >= 7).length} color="text-orange-600" />
          <Stat label="As of" value={data?.asOf ?? "—"} />
        </div>
      </div>

      {/* breadth */}
      <div className="bg-bg-card border border-border rounded p-3">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="card-header text-text-secondary">Shown names · above SMA50 <span className="font-normal normal-case tracking-normal">(filtered view — see Market Posture above for the market read)</span></span>
          <span className="tabular-nums">{breadthPct}% ({above}/{filtered.length})</span>
        </div>
        <div className="h-2 bg-bg-secondary rounded overflow-hidden">
          <div className="h-full bg-signal-bull transition-all" style={{ width: `${breadthPct}%` }} />
        </div>
      </div>

      {error && (
        <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm">{error}</div>
      )}

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 bg-bg-card border border-border rounded p-2.5">
        <div className="flex gap-1">
          {([["extension", "Extension Matrix"], ["rts", "RTS Matrix"], ["positions", "Positions"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded ${view === k ? "bg-text-primary text-bg-primary" : "text-text-secondary hover:text-text-primary hover:bg-bg-secondary"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") doLookup(search); }}
          placeholder="ticker… (Enter = look up any symbol)"
          className="bg-bg-card border border-border rounded px-2 py-1 text-sm w-52 focus:outline-none focus:border-accent"
        />
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={fAtr} onChange={(e) => setFAtr(e.target.checked)} /> above-avg ATR
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={fTrend} onChange={(e) => setFTrend(e.target.checked)} /> trend-aligned
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={fRvol} onChange={(e) => setFRvol(e.target.checked)} /> high RVOL
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-accent cursor-pointer">
          <input type="checkbox" checked={fCandidate} onChange={(e) => setFCandidate(e.target.checked)} /> trending candidates
        </label>
        <select value={fAction} onChange={(e) => setFAction(e.target.value)} className="rounded px-2 py-1 text-xs">
          <option value="">action: all</option>
          {(["buy", "reduce", "sell", "hold"] as AtrAction[]).map((a) => (
            <option key={a} value={a}>action: {a}</option>
          ))}
        </select>
        <select value={fSector} onChange={(e) => setFSector(e.target.value)} className="rounded px-2 py-1 text-xs max-w-[160px]">
          <option value="">sector: all</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={resetFilters} className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary border border-border rounded">reset</button>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary px-1">
        <span className="uppercase tracking-wider">border = action:</span>
        {ACTION_LABEL.map((a) => (
          <span key={a.key} className={`px-1.5 py-0.5 border-l-2 border rounded ${ACTION_BORDER[a.key]} ${a.cls}`}>{a.key}</span>
        ))}
        <span className="opacity-50">·</span>
        <span className="uppercase tracking-wider">zones:</span>
        <span className="text-red-700">leave (&lt;0)</span>
        <span className="text-emerald-700">entry (0–4)</span>
        <span className="text-amber-700">hold (5–6)</span>
        <span className="text-orange-600">extended (7–10)</span>
        <span className="text-fuchsia-700">blow-off (11+)</span>
        <span className="opacity-50">·</span>
        <span>🔥 = RVOL ≥ 2× (volume confirmation)</span>
      </div>

      {/* reverse lookup */}
      {(lookup || lookupLoading || lookupErr) && (
        <div>
          {lookupLoading && <div className="text-xs text-text-secondary py-2">Looking up…</div>}
          {lookupErr && (
            <div className="p-3 bg-signal-bear/10 border border-signal-bear/30 rounded text-signal-bear text-sm flex items-center justify-between">
              <span>Lookup failed: {lookupErr}</span>
              <button onClick={() => setLookupErr(null)} className="hover:text-text-primary">✕</button>
            </div>
          )}
          {lookup && <StockDetail res={lookup} onClose={() => setLookup(null)} />}
        </div>
      )}

      {/* focus — buy or sell, defaulted by index breadth */}
      <div className="bg-bg-card border border-border rounded p-3">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <div>
            <h3 className="section-header text-sm font-bold">
              {focusMode === "sell" ? "Sell Focus" : "Morning Focus"}
              <span className="text-accent font-normal text-xs normal-case tracking-normal"> · for next open{data?.asOf ? ` (from ${data.asOf} close)` : ""}</span>
            </h3>
            <div className="text-[11px] text-text-secondary normal-case tracking-normal">
              {focusMode === "sell"
                ? "below SMA50 · breakdowns to exit / avoid · most-broken first"
                : "buy · 0–4x · ATR RS ≥ 50 · least-extended first"}
              {" · EOD list · "}
              <span className={marketBias === "sell" ? "text-red-700" : "text-emerald-700"}>
                index breadth → {marketBias === "sell" ? "defensive (sell bias)" : "buying environment"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded overflow-hidden border border-border">
              {(["buy", "sell"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setFocusMode(m); setFocusTouched(true); }}
                  className={`px-3 py-1 text-xs font-bold uppercase ${focusMode === m ? (m === "sell" ? "bg-red-600 text-white" : "bg-emerald-600 text-white") : "bg-bg-card text-text-secondary hover:text-text-primary"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            {focus.length > 0 && (
              <button
                onClick={() => navigator.clipboard.writeText(focus.map((s) => `$${s.ticker}`).join(" "))}
                className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary border border-border rounded"
              >
                copy $tickers
              </button>
            )}
          </div>
        </div>
        {focus.length === 0 ? (
          <div className="text-xs text-text-secondary py-2">
            {focusMode === "sell" ? "No breakdown (sell-action) names in the current scan." : "No buy-action, 0–4x candidates in the current scan."}
          </div>
        ) : (
          <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
            {focus.map((s) => <Chip key={s.ticker} s={s} onHover={onHover} onLeave={onLeave} />)}
          </div>
        )}
      </div>

      {/* views */}
      {loading ? (
        <div className="py-12 text-center text-text-secondary text-sm">Loading…</div>
      ) : !data ? (
        <div className="py-12 text-center text-text-secondary text-sm">No snapshot yet. The scan runs weekdays at 4:30 PM ET.</div>
      ) : view === "extension" ? (
        <ExtensionView rows={filtered} isolate={isolate} setIsolate={setIsolate} onHover={onHover} onLeave={onLeave} />
      ) : view === "rts" ? (
        <RtsView rows={filtered} onHover={onHover} onLeave={onLeave} />
      ) : (
        <PositionsView stocks={stocks} positions={positions} onSave={savePositions} />
      )}

      <div className="text-[11px] text-text-secondary px-1 pt-2 border-t border-border">
        Mechanical, unaudited signals for educational use — <span className="text-text-primary">not financial advice</span>.
        Extension = (Close − SMA50) / ATR. Percentiles (RS, ATR RS) are relative to the scanned universe.
        Framework credit: @SteveDJacobs, @jfsrevg, @RealSimpleAriel.
      </div>
    </div>
  );
}

// ─── Extension Matrix — single row of bucket columns, histogram folded in ────

function ExtensionView({ rows, isolate, setIsolate, onHover, onLeave }: {
  rows: AtrStock[]; isolate: number | null; setIsolate: (b: number | null) => void;
  onHover: (t: TipState) => void; onLeave: () => void;
}) {
  const buckets: Record<number, AtrStock[]> = {};
  for (let b = -5; b <= 11; b++) buckets[b] = [];
  for (const s of rows) buckets[Math.max(-5, Math.min(11, s.bucket))].push(s);
  const max = Math.max(1, ...Object.values(buckets).map((a) => a.length));
  const cols: number[] = [];
  for (let b = -5; b <= 11; b++) if (isolate == null || isolate === b) cols.push(b);

  return (
    <div className="bg-bg-card border border-border rounded p-2 overflow-x-auto">
      <div
        className="grid gap-1.5 items-start min-w-max"
        style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(${isolate != null ? "180px" : "92px"}, 1fr))` }}
      >
        {cols.map((b) => {
          const zone = ZONE[zoneOf(b)];
          const list = buckets[b];
          return (
            <div key={b} className="flex flex-col">
              {/* header with folded-in histogram bar */}
              <button
                onClick={() => setIsolate(isolate === b ? null : b)}
                className={`flex flex-col justify-end h-16 rounded-t px-1 pt-1 ${zone.tint} border-b-2 ${zone.border}`}
                title={`${list.length} names`}
              >
                <span className="text-[10px] tabular-nums text-text-secondary leading-none">{list.length || ""}</span>
                <div className="flex items-end h-7 mt-0.5">
                  <div className={`w-full rounded-t ${zone.bar}`} style={{ height: `${Math.max(2, (list.length / max) * 28)}px` }} />
                </div>
                <span className={`text-[10px] font-bold tabular-nums leading-none mt-0.5 ${zone.text}`}>{b === 11 ? "11+" : `${b}x`}</span>
              </button>
              {/* ticker chips */}
              <div className="flex flex-col gap-0.5 p-0.5">
                {list.sort((a, c) => a.ext - c.ext).map((s) => <Chip key={s.ticker} s={s} onHover={onHover} onLeave={onLeave} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── RTS Matrix — single row of grade columns ───────────────────────────────

function RtsView({ rows, onHover, onLeave }: { rows: AtrStock[]; onHover: (t: TipState) => void; onLeave: () => void }) {
  const cols: Record<string, AtrStock[]> = {};
  for (const g of GRADES) cols[g] = [];
  for (const s of rows) if (cols[s.grade]) cols[s.grade].push(s);

  function bandColor(g: string): string {
    const c = g[0];
    if (c <= "C") return "text-emerald-700";
    if (c <= "E") return "text-amber-700";
    return "text-red-700";
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 text-[10px] font-bold uppercase tracking-wider text-center">
        <div className="bg-emerald-50 text-emerald-700 border border-emerald-200 rounded py-1">Strong (A–C)</div>
        <div className="bg-amber-50 text-amber-700 border border-amber-200 rounded py-1">Transitional (D–E)</div>
        <div className="bg-red-50 text-red-700 border border-red-200 rounded py-1">Weak (F–G)</div>
      </div>
      <div className="bg-bg-card border border-border rounded p-2 overflow-x-auto">
        <div className="grid gap-1.5 items-start min-w-max" style={{ gridTemplateColumns: `repeat(${GRADES.length}, minmax(84px, 1fr))` }}>
          {GRADES.map((g) => (
            <div key={g} className="flex flex-col">
              <div className="flex items-baseline justify-between px-1 py-1 bg-bg-secondary rounded-t border-b border-border">
                <span className={`text-[11px] font-bold ${bandColor(g)}`}>{g}</span>
                <span className="text-[10px] text-text-secondary tabular-nums">{cols[g].length}</span>
              </div>
              <div className="flex flex-col gap-0.5 p-0.5">
                {cols[g].sort((a, b) => b.rs - a.rs).map((s) => <Chip key={s.ticker} s={s} onHover={onHover} onLeave={onLeave} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Positions view (localStorage) ──────────────────────────────────────────

function PositionsView({ stocks, positions, onSave }: {
  stocks: AtrStock[]; positions: AtrPosition[]; onSave: (p: AtrPosition[]) => void;
}) {
  const [ticker, setTicker] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [entryPrice, setEntryPrice] = useState("");
  const [shares, setShares] = useState("");
  const [stop, setStop] = useState("");

  const byTicker: Record<string, AtrStock> = {};
  for (const s of stocks) byTicker[s.ticker] = s;

  function add() {
    const t = ticker.trim().toUpperCase();
    const ep = parseFloat(entryPrice);
    if (!t || !Number.isFinite(ep)) return;
    const pos: AtrPosition = { ticker: t, entryDate, entryPrice: ep, shares: parseInt(shares || "0", 10), stop: parseFloat(stop || "0") };
    onSave([...positions.filter((p) => p.ticker !== t), pos]);
    setTicker(""); setEntryDate(""); setEntryPrice(""); setShares(""); setStop("");
  }
  function del(t: string) { onSave(positions.filter((p) => p.ticker !== t)); }

  const inputCls = "bg-bg-card border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 bg-bg-card border border-border rounded p-3">
        <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ticker" className={`${inputCls} w-24`} />
        <input value={entryDate} onChange={(e) => setEntryDate(e.target.value)} type="date" className={inputCls} />
        <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} type="number" step="0.01" placeholder="entry $" className={`${inputCls} w-24`} />
        <input value={shares} onChange={(e) => setShares(e.target.value)} type="number" placeholder="shares" className={`${inputCls} w-24`} />
        <input value={stop} onChange={(e) => setStop(e.target.value)} type="number" step="0.01" placeholder="stop $" className={`${inputCls} w-24`} />
        <button onClick={add} className="px-3 py-1 text-xs font-bold text-bg-primary bg-text-primary rounded">+ add position</button>
        <span className="text-[11px] text-text-secondary self-center">Positions are stored in this browser only.</span>
      </div>

      <div className="bg-bg-card border border-border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
            <tr>
              {["ticker", "entry", "last", "P&L (R)", "P&L %", "ext / zone", "stop", "scale-out ladder", "action", ""].map((h, i) => (
                <th key={i} className="py-2 px-3 text-left whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr><td colSpan={10} className="py-8 text-center text-text-secondary text-sm">No positions yet.</td></tr>
            )}
            {positions.map((p) => {
              const m = byTicker[p.ticker];
              const last = m?.close ?? p.entryPrice;
              const risk = (p.entryPrice - (p.stop || 0)) || 1;
              const r = ((last - p.entryPrice) / risk).toFixed(2);
              const pct = (((last - p.entryPrice) / p.entryPrice) * 100).toFixed(2);
              const ladder = m?.ladder ?? {};
              return (
                <tr key={p.ticker} className="border-b border-border">
                  <td className="py-2 px-3 font-bold">{p.ticker}</td>
                  <td className="py-2 px-3 tabular-nums">${p.entryPrice}</td>
                  <td className="py-2 px-3 tabular-nums">${last}</td>
                  <td className={`py-2 px-3 tabular-nums ${+r >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>{r}R</td>
                  <td className={`py-2 px-3 tabular-nums ${+pct >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>{pct}%</td>
                  <td className="py-2 px-3 tabular-nums">{m ? `${m.ext} · ${m.zone}` : "—"}</td>
                  <td className="py-2 px-3 tabular-nums">${p.stop || m?.stopSuggest || "—"}</td>
                  <td className="py-2 px-3">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(ladder).map(([k, v]) => (
                        <span key={k} className={`px-1 py-0.5 text-[10px] rounded border ${last >= (v as number) ? "border-emerald-600 text-emerald-700" : "border-border text-text-secondary"}`}>
                          {k}x ${v}
                        </span>
                      ))}
                      {Object.keys(ladder).length === 0 && "—"}
                    </div>
                  </td>
                  <td className="py-2 px-3">{m?.action ?? "—"}</td>
                  <td className="py-2 px-3"><button onClick={() => del(p.ticker)} className="text-text-secondary hover:text-signal-bear">✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
