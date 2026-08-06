import { useEffect, useMemo, useState } from "react";
import type {
  MmSectorDeskData,
  MmIndexLeadersData,
  DeskGroup,
  DeskRankedStock,
  DeskDirection,
  IndexBlock,
} from "../types.js";
import { getMmPanel } from "../services/api.js";

/**
 * Sector Desk — which sector group is running today, and which liquid stocks
 * inside it are running with it. Direction is LONG / SHORT; the operator picks
 * their own options off that. NO options data is shown anywhere.
 *
 * Two cron-warmed FinViz panels (`sector-desk`, `index-leaders`) read cache-only
 * via /api/mm-panel. A cold panel shows "not computed yet" rather than computing
 * on demand. Polls every 60s; a fetch failure shows an error, never stale-as-live.
 */

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${t}`;
const POLL_MS = 60_000;

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const pctTone = (v: number) =>
  v > 0.02 ? "text-signal-bull" : v < -0.02 ? "text-signal-bear" : "text-text-secondary";

function fmtDollar(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtVol(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${v}`;
}

function DirBadge({ dir, dim }: { dir: DeskDirection | null; dim?: boolean }) {
  if (!dir) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border border-border text-text-secondary">
        no gate
      </span>
    );
  }
  const cls =
    dir === "LONG"
      ? "bg-signal-bull/15 text-signal-bull border-signal-bull/40"
      : "bg-signal-bear/15 text-signal-bear border-signal-bear/40";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${cls} ${dim ? "opacity-60" : ""}`}>
      {dir}
    </span>
  );
}

// ─── Rotation rail (SVG — precise, overlap-free label lanes at any width) ────

const DEAD_BAND = 0.55; // ±% amber "no group edge" zone

function RotationRail({
  groups,
  selectedKey,
  onSelect,
}: {
  groups: DeskGroup[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const W = 1000;
  const labelTop = 12; // baseline of the ETF label row
  const axisY = 78; // single label row above; slanted leaders reach the axis
  const H = axisY + 40;
  const MARGIN = 24;
  const LABEL_W = 52; // min horizontal gap between label centers (declutter)

  const maxAbs = Math.max(3, ...groups.map((g) => Math.abs(g.etfMove))) * 1.15;
  const xOf = (move: number) => {
    const frac = 0.5 + (move / maxAbs) * 0.5;
    return Math.max(0.03, Math.min(0.97, frac)) * W;
  };

  // Single-row label declutter: sort by pin x, then push each label center at
  // least LABEL_W past the previous one. Leader lines slant from the (possibly
  // nudged) label down to the true pin, so nothing ever overlaps regardless of
  // how tightly the pins cluster on a flat day.
  const sorted = [...groups]
    .map((g) => ({ g, x: xOf(g.etfMove) }))
    .sort((a, b) => a.x - b.x);
  let cursor = -Infinity;
  const placed = sorted.map(({ g, x }) => {
    const labelX = Math.max(x, cursor + LABEL_W);
    cursor = labelX;
    return { g, x, labelX };
  });
  // If the decluttered row overflows the right edge, shift the whole row left.
  const overflow = placed.length ? placed[placed.length - 1].labelX - (W - MARGIN) : 0;
  if (overflow > 0) for (const p of placed) p.labelX -= overflow;

  const deadLeft = xOf(-DEAD_BAND);
  const deadRight = xOf(DEAD_BAND);
  const ticks = [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="xMidYMid meet">
      {/* dead-band */}
      <rect x={deadLeft} y={axisY - 10} width={deadRight - deadLeft} height={20} className="fill-amber-500/10" />
      <line x1={deadLeft} y1={axisY - 12} x2={deadLeft} y2={axisY + 12} className="stroke-amber-500/40" strokeDasharray="2 2" />
      <line x1={deadRight} y1={axisY - 12} x2={deadRight} y2={axisY + 12} className="stroke-amber-500/40" strokeDasharray="2 2" />
      <text x={(deadLeft + deadRight) / 2} y={axisY + 32} textAnchor="middle" className="fill-amber-600 text-[11px] font-medium">
        no group edge (±{DEAD_BAND}%)
      </text>

      {/* axis + ticks */}
      <line x1={0} y1={axisY} x2={W} y2={axisY} className="stroke-border" strokeWidth={1.5} />
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={xOf(t)} y1={axisY - 4} x2={xOf(t)} y2={axisY + 4} className="stroke-text-secondary" />
          <text x={xOf(t)} y={axisY + 18} textAnchor="middle" className="fill-text-secondary text-[10px] tabular-nums">
            {t === 0 ? "0%" : `${t > 0 ? "+" : ""}${t.toFixed(1)}%`}
          </text>
        </g>
      ))}

      {/* leader lines (drawn first so pins/labels sit on top) */}
      {placed.map(({ g, x, labelX }) => {
        const selected = g.key === selectedKey;
        return (
          <line
            key={`l-${g.key}`}
            x1={labelX}
            y1={labelTop + 14}
            x2={x}
            y2={axisY - 5}
            className="stroke-border"
            strokeWidth={selected ? 1.5 : 0.75}
          />
        );
      })}

      {/* pins + labels */}
      {placed.map(({ g, x, labelX }) => {
        const inDead = Math.abs(g.etfMove) < DEAD_BAND;
        const color = inDead ? "text-amber-500" : g.etfMove >= 0 ? "text-signal-bull" : "text-signal-bear";
        const selected = g.key === selectedKey;
        return (
          <g key={g.key} className="cursor-pointer" onClick={() => onSelect(g.key)}>
            <circle cx={x} cy={axisY} r={selected ? 6 : 4} className={`${color} ${g.tradeable ? "fill-current" : "fill-bg-primary stroke-current"}`} strokeWidth={1.5} />
            <text x={labelX} y={labelTop} textAnchor="middle" className={`${color} ${selected ? "font-bold" : "font-semibold"} text-[11px]`}>
              {g.etf}
            </text>
            <text x={labelX} y={labelTop + 11} textAnchor="middle" className="fill-text-secondary text-[9px] tabular-nums">
              {fmtPct(g.etfMove)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── In-group stock table ────────────────────────────────────────────────────

function StockTable({ group }: { group: DeskGroup }) {
  if (group.stocks.length === 0) {
    return <p className="text-sm text-text-secondary px-1 py-3">No liquid members running with the group.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border">
            <th className="text-left px-2 py-1.5 font-semibold">Ticker</th>
            <th className="text-right px-2 py-1.5 font-semibold">Chg</th>
            <th className="text-right px-2 py-1.5 font-semibold">RVol</th>
            <th className="text-right px-2 py-1.5 font-semibold">$ Vol</th>
            <th className="text-right px-2 py-1.5 font-semibold">Aligned</th>
            <th className="text-left px-2 py-1.5 font-semibold w-40">Score</th>
          </tr>
        </thead>
        <tbody>
          {group.stocks.map((s: DeskRankedStock) => {
            const flagged = s.flags.length > 0;
            return (
              <tr key={s.ticker} className={`border-b border-border/50 ${flagged ? "opacity-60" : ""}`}>
                <td className="px-2 py-1.5">
                  <a href={TV(s.ticker)} target="_blank" rel="noreferrer" className="font-bold hover:underline">
                    {s.ticker}
                  </a>
                  {s.flags.map((f) => (
                    <span key={f} className="ml-1.5 px-1 py-0.5 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-600 border border-amber-500/30">
                      {f}
                    </span>
                  ))}
                </td>
                <td className={`text-right px-2 py-1.5 tabular-nums font-semibold ${pctTone(s.chg)}`}>{fmtPct(s.chg)}</td>
                <td className="text-right px-2 py-1.5 tabular-nums">{s.relVol.toFixed(2)}×</td>
                <td className="text-right px-2 py-1.5 tabular-nums">{fmtDollar(s.dollarVol)}</td>
                <td className={`text-right px-2 py-1.5 tabular-nums ${pctTone(s.aligned)}`}>{fmtPct(s.aligned)}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-bg-secondary overflow-hidden">
                      <div
                        className={`h-full ${s.side === "LONG" ? "bg-signal-bull" : "bg-signal-bear"}`}
                        style={{ width: `${Math.max(2, Math.min(100, s.score))}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-xs font-semibold w-7 text-right">{s.score}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Group list row ──────────────────────────────────────────────────────────

function GroupRow({
  g,
  selected,
  onSelect,
}: {
  g: DeskGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded border transition-colors ${
        selected ? "border-text-primary bg-bg-secondary" : "border-border hover:bg-bg-secondary/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-sm truncate">{g.sector}</span>
          <span className="text-[10px] text-text-secondary font-mono">{g.etf}</span>
        </div>
        <DirBadge dir={g.tradeable ? g.bias : null} />
      </div>
      <div className="flex items-center gap-3 mt-1 text-[11px] tabular-nums text-text-secondary flex-wrap">
        <span className={pctTone(g.etfMove)}>{fmtPct(g.etfMove)}</span>
        <span>{g.etfRvol.toFixed(2)}× rvol</span>
        <span>{Math.round(g.breadth * 100)}% breadth</span>
        <span>{g.memberCount} names</span>
      </div>
      {g.blockers.length > 0 && (
        <div className="mt-1 text-[10px] text-amber-600">{g.blockers.join(" · ")}</div>
      )}
    </button>
  );
}

// ─── Index Leaders card ──────────────────────────────────────────────────────

function IndexCard({ block }: { block: IndexBlock }) {
  return (
    <div className="bg-bg-card border border-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm">{block.label}</h3>
        <span className="text-[10px] text-text-secondary">{block.memberCount} liquid</span>
      </div>
      {block.leaders.length === 0 ? (
        <p className="text-xs text-text-secondary">No leaders.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {block.leaders.map((l) => (
              <tr key={l.ticker} className="border-b border-border/40 last:border-0">
                <td className="py-1">
                  <a href={TV(l.ticker)} target="_blank" rel="noreferrer" className="font-bold hover:underline">
                    {l.ticker}
                  </a>
                </td>
                <td className={`py-1 text-right tabular-nums font-semibold ${pctTone(l.chg)}`}>{fmtPct(l.chg)}</td>
                <td className="py-1 text-right tabular-nums text-text-secondary">{fmtVol(l.volume)}</td>
                <td className="py-1 text-right tabular-nums text-text-secondary">{l.relVol.toFixed(1)}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

type PanelState<T> = { data: T | null; error: string | null; loading: boolean };

export function SectorDeskPage() {
  const [desk, setDesk] = useState<PanelState<MmSectorDeskData>>({ data: null, error: null, loading: true });
  const [idx, setIdx] = useState<PanelState<MmIndexLeadersData>>({ data: null, error: null, loading: true });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await getMmPanel<MmSectorDeskData>("sector-desk");
        if (alive) setDesk({ data: r.data, error: null, loading: false });
      } catch (e) {
        if (alive) setDesk((p) => ({ data: p.data, error: (e as Error).message, loading: false }));
      }
      try {
        const r = await getMmPanel<MmIndexLeadersData>("index-leaders");
        if (alive) setIdx({ data: r.data, error: null, loading: false });
      } catch (e) {
        if (alive) setIdx((p) => ({ data: p.data, error: (e as Error).message, loading: false }));
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const groups = desk.data?.groups ?? [];
  const regime = desk.data?.regime;

  // Auto-select: first regime target, else strongest tradeable group, else top.
  const autoKey = useMemo(() => {
    if (groups.length === 0) return null;
    const targetSector = regime?.targets[0]?.sector;
    if (targetSector) {
      const m = groups.find((g) => g.sector === targetSector);
      if (m) return m.key;
    }
    const tradeable = groups.find((g) => g.tradeable);
    return (tradeable ?? groups[0]).key;
  }, [groups, regime]);

  const activeKey = selectedKey ?? autoKey;
  const active = groups.find((g) => g.key === activeKey) ?? null;

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div>
        <h1 className="font-[var(--font-playfair)] text-2xl font-black">Sector Desk</h1>
        <p className="text-xs text-text-secondary mt-0.5">
          Which group is running, and the liquid names running with it. Direction only — you pick the options.
          {desk.data && <span className="ml-2 text-dim">· as of {desk.data.generatedEt} ET</span>}
        </p>
      </div>

      {/* Regime banner */}
      {desk.loading && !desk.data && <div className="text-sm text-text-secondary">Loading…</div>}
      {desk.error && !desk.data && (
        <div className="bg-bg-card border border-border rounded p-4 text-sm">
          <p className="font-semibold text-amber-600">Sector desk not available</p>
          <p className="text-text-secondary mt-1">{desk.error} — this panel is filled by the scheduled refresh; try again shortly.</p>
        </div>
      )}
      {regime && (
        <div
          className={`rounded border-l-4 px-4 py-3 bg-bg-card ${
            regime.vehicle === "SECTOR" ? "border-l-signal-bull" : "border-l-amber-500"
          }`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
              regime.vehicle === "SECTOR" ? "bg-signal-bull/15 text-signal-bull" : "bg-amber-500/15 text-amber-600"
            }`}>
              {regime.state.replace("_", "-")}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-text-secondary">vehicle: {regime.vehicle}</span>
            <span className="text-[10px] text-text-secondary tabular-nums">spread {regime.dispersion.toFixed(2)}pt</span>
          </div>
          <p className="font-semibold text-base mt-1.5">{regime.headline}</p>
          <p className="text-sm text-text-secondary">{regime.detail}</p>
          {desk.data?.sessionNote && <p className="text-[11px] text-dim mt-1.5 italic">{desk.data.sessionNote}</p>}
        </div>
      )}

      {/* Rotation rail */}
      {groups.length > 0 && (
        <div className="bg-bg-card border border-border rounded p-3">
          <h2 className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">Rotation rail — SPDR sector ETFs</h2>
          <RotationRail groups={groups} selectedKey={activeKey} onSelect={setSelectedKey} />
        </div>
      )}

      {/* Groups + in-group stocks */}
      {groups.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_1fr] gap-4">
          <div className="space-y-1.5">
            <h2 className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">Groups (by strength)</h2>
            {groups.map((g) => (
              <GroupRow key={g.key} g={g} selected={g.key === activeKey} onSelect={() => setSelectedKey(g.key)} />
            ))}
          </div>
          <div className="bg-bg-card border border-border rounded p-3 min-w-0">
            {active ? (
              <>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <h2 className="font-semibold">{active.sector}</h2>
                  <DirBadge dir={active.tradeable ? active.bias : null} dim={!active.tradeable} />
                  <span className={`text-sm tabular-nums ${pctTone(active.etfMove)}`}>{fmtPct(active.etfMove)}</span>
                  <span className="text-xs text-text-secondary tabular-nums">{active.etfRvol.toFixed(2)}× rvol · {Math.round(active.breadth * 100)}% breadth</span>
                </div>
                {!active.tradeable && (
                  <p className="text-[11px] text-amber-600 mb-2">
                    Not a clean group edge — showing the names anyway: {active.blockers.join(" · ")}
                  </p>
                )}
                <StockTable group={active} />
              </>
            ) : (
              <p className="text-sm text-text-secondary">Select a group.</p>
            )}
          </div>
        </div>
      )}

      {/* Index leaders */}
      <div>
        <h2 className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">
          Index Leaders — top-3 high-volume gainers
          {idx.data && <span className="ml-2 text-dim normal-case tracking-normal">· as of {idx.data.generatedEt} ET</span>}
        </h2>
        {idx.error && !idx.data && <p className="text-sm text-text-secondary">{idx.error} — filled by the scheduled refresh.</p>}
        {idx.data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {idx.data.indices.map((b) => (
              <IndexCard key={b.key} block={b} />
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-dim text-center">
        Real-time via FinViz Elite, cron-warmed ~5 min. Not financial advice.
      </p>
    </div>
  );
}
