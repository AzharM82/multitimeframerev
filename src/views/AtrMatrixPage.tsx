import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AtrStock, AtrScanResponse, AtrZone, AtrAction, AtrPosition } from "../types.js";
import { getAtrScan } from "../services/api.js";

/* ATR Matrix — swing extension scanner. EOD-only: the snapshot is produced once
   after close by atr-eod-timer. Framework credit: @SteveDJacobs. */

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t)}`;
const GRADES = ["A+","A","A-","B+","B","B-","C+","C","C-","D+","D","D-","E+","E","E-","F+","F","F-","G+","G","G-"];
const POS_KEY = "atr_positions";

type ViewKey = "extension" | "rts" | "positions";

const ZONE_BAR: Record<AtrZone, string> = {
  LEAVE: "bg-signal-bear",
  ENTRY: "bg-signal-bull",
  HOLD: "bg-amber-400",
  EXTENDED: "bg-orange-500",
  BLOWOFF: "bg-fuchsia-500",
};
const ACTION_BORDER: Record<AtrAction, string> = {
  buy: "border-signal-bull",
  inflection: "border-orange-400",
  restore: "border-amber-400",
  reduce: "border-sky-400",
  sell: "border-signal-bear",
  hold: "border-border",
};
const ACTION_LABEL: { key: AtrAction; cls: string }[] = [
  { key: "buy", cls: "text-signal-bull" },
  { key: "inflection", cls: "text-orange-400" },
  { key: "restore", cls: "text-amber-400" },
  { key: "reduce", cls: "text-sky-400" },
  { key: "sell", cls: "text-signal-bear" },
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
      className="fixed z-50 w-60 p-3 rounded-lg border border-border bg-bg-card text-xs shadow-xl pointer-events-none space-y-0.5"
      style={style}
    >
      <div className="font-bold text-sm mb-1 truncate">{s.ticker} · <span className="text-text-secondary font-normal">{s.company}</span></div>
      <Row k="close" v={`$${s.close} (${fmtPct(s.chg)})`} />
      <Row k="ATR" v={`$${s.atr} · ${s.atrPct}%`} />
      <Row k="ATR RS" v={`${s.atrRS}`} />
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
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border bg-bg-secondary hover:bg-bg-primary text-[11px] leading-tight ${ACTION_BORDER[s.action]} ${s.bucket >= 7 ? "font-bold" : ""}`}
    >
      <span className="font-bold">{s.ticker}</span>
      <span className={`tabular-nums ${s.chg >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>{fmtPct(s.chg)}</span>
      {s.bucket >= 11 && <span className="text-fuchsia-400 tabular-nums">{Math.round(s.ext)}x</span>}
    </button>
  );
}

// ─── stat card ──────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-bg-card border border-border rounded-lg px-3 py-2 min-w-[88px]">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className="text-lg font-bold tabular-nums mt-0.5">{value}</div>
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
  const [isolate, setIsolate] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [positions, setPositions] = useState<AtrPosition[]>([]);

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
    try { setPositions(JSON.parse(localStorage.getItem(POS_KEY) || "[]")); } catch { setPositions([]); }
  }, []);
  function savePositions(next: AtrPosition[]) {
    setPositions(next);
    localStorage.setItem(POS_KEY, JSON.stringify(next));
  }

  const stocks = data?.stocks ?? [];

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
    return rows;
  }, [stocks, search, fAtr, fTrend, fAction, fSector]);

  const focus = useMemo(
    () => stocks.filter((s) => s.action === "buy" && s.ext >= 0 && s.ext <= 4 && s.atrRS >= 50).sort((a, b) => a.ext - b.ext),
    [stocks],
  );

  const above = filtered.filter((s) => s.aboveSMA50).length;
  const breadthPct = filtered.length ? Math.round((100 * above) / filtered.length) : 0;

  function resetFilters() {
    setSearch(""); setFAtr(false); setFTrend(false); setFAction(""); setFSector(""); setIsolate(null);
  }

  const onHover = (t: TipState) => setTip(t);
  const onLeave = () => setTip(null);

  // ── render ──
  return (
    <div className="space-y-4">
      <Tooltip tip={tip} />

      {/* header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-secondary">@SteveDJacobs · Relative Trend Strength</div>
          <h2 className="text-xl font-bold mt-1">ATR <span className="text-accent">Matrix</span></h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Stat label="Universe" value={data?.count ?? "—"} />
          <Stat label="Showing" value={filtered.length} />
          <Stat label="Avg ATR%" value={data ? `${data.avgAtrPct}%` : "—"} />
          <Stat label="Buyable" value={filtered.filter((r) => r.action === "buy").length} />
          <Stat label="7x+ Ext" value={filtered.filter((r) => r.bucket >= 7).length} />
          <div className="bg-bg-card border border-border rounded-lg px-3 py-2">
            <div className="text-[10px] uppercase tracking-widest text-text-secondary">As of</div>
            <div className="text-lg font-bold tabular-nums mt-0.5">{data?.asOf ?? "—"}</div>
          </div>
        </div>
      </div>

      {/* breadth */}
      <div className="bg-bg-card border border-border rounded-lg p-3">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-text-secondary uppercase tracking-wider">Breadth · above SMA50</span>
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
      <div className="flex flex-wrap items-center gap-2 bg-bg-card border border-border rounded-lg p-3">
        <div className="flex gap-1">
          {([["extension", "Extension Matrix"], ["rts", "RTS Matrix"], ["positions", "Positions"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border-b-2 ${view === k ? "text-accent border-accent" : "text-text-secondary border-transparent hover:text-text-primary"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search ticker…"
          className="bg-bg-secondary border border-border rounded px-2 py-1 text-sm w-36 focus:outline-none focus:border-accent"
        />
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={fAtr} onChange={(e) => setFAtr(e.target.checked)} /> above-avg ATR
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={fTrend} onChange={(e) => setFTrend(e.target.checked)} /> trend-aligned
        </label>
        <select value={fAction} onChange={(e) => setFAction(e.target.value)} className="bg-bg-secondary border border-border rounded px-2 py-1 text-xs">
          <option value="">action: all</option>
          {(["buy", "inflection", "restore", "reduce", "sell", "hold"] as AtrAction[]).map((a) => (
            <option key={a} value={a}>action: {a}</option>
          ))}
        </select>
        <select value={fSector} onChange={(e) => setFSector(e.target.value)} className="bg-bg-secondary border border-border rounded px-2 py-1 text-xs max-w-[160px]">
          <option value="">sector: all</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={resetFilters} className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary border border-border rounded">reset</button>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary px-1">
        <span className="uppercase tracking-wider">border = action:</span>
        {ACTION_LABEL.map((a) => (
          <span key={a.key} className={`px-1.5 py-0.5 border rounded ${ACTION_BORDER[a.key]} ${a.cls}`}>{a.key}</span>
        ))}
        <span className="opacity-50">·</span>
        <span className="uppercase tracking-wider">zones:</span>
        <span className="text-signal-bear">leave (&lt;0)</span>
        <span className="text-signal-bull">entry (0–4)</span>
        <span className="text-amber-400">hold (5–6)</span>
        <span className="text-orange-400">extended (7–10)</span>
        <span className="text-fuchsia-400">blow-off (11+)</span>
      </div>

      {/* morning focus */}
      <div className="bg-bg-card border border-border rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold">Morning Focus <span className="text-text-secondary font-normal text-xs">· buy · 0–4x · ATR RS ≥ 50 · least-extended first</span></h3>
          {focus.length > 0 && (
            <button
              onClick={() => navigator.clipboard.writeText(focus.map((s) => `$${s.ticker}`).join(" "))}
              className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary border border-border rounded"
            >
              copy $tickers
            </button>
          )}
        </div>
        {focus.length === 0 ? (
          <div className="text-xs text-text-secondary py-2">No buy-action, 0–4x candidates in the current scan.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
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

// ─── Extension Matrix view ──────────────────────────────────────────────────

function ExtensionView({ rows, isolate, setIsolate, onHover, onLeave }: {
  rows: AtrStock[]; isolate: number | null; setIsolate: (b: number | null) => void;
  onHover: (t: TipState) => void; onLeave: () => void;
}) {
  const buckets: Record<number, AtrStock[]> = {};
  for (let b = -5; b <= 11; b++) buckets[b] = [];
  for (const s of rows) buckets[Math.max(-5, Math.min(11, s.bucket))].push(s);
  const max = Math.max(1, ...Object.values(buckets).map((a) => a.length));
  const cols = [];
  for (let b = -5; b <= 11; b++) cols.push(b);

  return (
    <div className="space-y-3">
      {/* histogram */}
      <div className="bg-bg-card border border-border rounded-lg p-3 flex items-end gap-1 overflow-x-auto">
        {cols.map((b) => (
          <button
            key={b}
            onClick={() => setIsolate(isolate === b ? null : b)}
            className={`flex flex-col items-center gap-1 flex-1 min-w-[34px] ${isolate === b ? "opacity-100" : isolate != null ? "opacity-40" : ""}`}
          >
            <span className="text-[10px] tabular-nums text-text-secondary h-3">{buckets[b].length || ""}</span>
            <div className="w-full flex items-end h-20">
              <div className={`w-full rounded-t ${ZONE_BAR[zoneOf(b)]}`} style={{ height: `${(buckets[b].length / max) * 80}px` }} />
            </div>
            <span className="text-[10px] tabular-nums text-text-secondary">{b === 11 ? "11+" : b}</span>
          </button>
        ))}
      </div>

      {/* bucket grid */}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
        {cols.filter((b) => isolate == null || isolate === b).map((b) => (
          <div key={b} className="bg-bg-card border border-border rounded-lg p-2">
            <div className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 ${ZONE_BAR[zoneOf(b)].replace("bg-", "text-")}`}>
              {b === 11 ? "11+" : `${b}x`} <span className="text-text-secondary">· {buckets[b].length}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {buckets[b].sort((a, c) => a.ext - c.ext).map((s) => <Chip key={s.ticker} s={s} onHover={onHover} onLeave={onLeave} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── RTS Matrix view ────────────────────────────────────────────────────────

function RtsView({ rows, onHover, onLeave }: { rows: AtrStock[]; onHover: (t: TipState) => void; onLeave: () => void }) {
  const cols: Record<string, AtrStock[]> = {};
  for (const g of GRADES) cols[g] = [];
  for (const s of rows) if (cols[s.grade]) cols[s.grade].push(s);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 text-[10px] font-bold uppercase tracking-wider text-center">
        <div className="bg-signal-bull/15 text-signal-bull rounded py-1">Strong (A–C)</div>
        <div className="bg-amber-400/15 text-amber-400 rounded py-1">Transitional (D–E)</div>
        <div className="bg-signal-bear/15 text-signal-bear rounded py-1">Weak (F–G)</div>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
        {GRADES.map((g) => (
          <div key={g} className="bg-bg-card border border-border rounded-lg p-2">
            <div className="text-[10px] font-bold mb-1.5">{g} <span className="text-text-secondary">· {cols[g].length}</span></div>
            <div className="flex flex-wrap gap-1">
              {cols[g].sort((a, b) => b.rs - a.rs).map((s) => <Chip key={s.ticker} s={s} onHover={onHover} onLeave={onLeave} />)}
            </div>
          </div>
        ))}
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

  const inputCls = "bg-bg-secondary border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 bg-bg-card border border-border rounded-lg p-3">
        <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ticker" className={`${inputCls} w-24`} />
        <input value={entryDate} onChange={(e) => setEntryDate(e.target.value)} type="date" className={inputCls} />
        <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} type="number" step="0.01" placeholder="entry $" className={`${inputCls} w-24`} />
        <input value={shares} onChange={(e) => setShares(e.target.value)} type="number" placeholder="shares" className={`${inputCls} w-24`} />
        <input value={stop} onChange={(e) => setStop(e.target.value)} type="number" step="0.01" placeholder="stop $" className={`${inputCls} w-24`} />
        <button onClick={add} className="px-3 py-1 text-xs font-bold text-accent border border-accent rounded">+ add position</button>
        <span className="text-[11px] text-text-secondary self-center">Positions are stored in this browser only.</span>
      </div>

      <div className="bg-bg-card border border-border rounded-lg overflow-x-auto">
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
                        <span key={k} className={`px-1 py-0.5 text-[10px] rounded border ${last >= (v as number) ? "border-signal-bull text-signal-bull" : "border-border text-text-secondary"}`}>
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
