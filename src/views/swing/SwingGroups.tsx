import { useMemo, useState } from "react";
import type { SwingRow } from "../../types.js";
import { useTableSort, SortHeaderRow, type SortColumn } from "../shared/tableSort.js";

/**
 * Swing Strength — Phase 4: group rollups.
 *
 * The same rows the table shows, folded by sector or industry, so the
 * question "which group is more bullish than bearish right now" has one
 * answer per lens and one overall:
 *
 *   MA        bull-stack % vs bear-stack % (Lens 1)
 *   Reversal  bullish % (triggered + in progress) vs bearish % (Lens 2), with
 *             the triggered-this-week count shown separately
 *   Stage     Stage 2 % vs Stage 3+4 % (Lens 3), with breakouts
 *   Net       the mean of the three (bull − bear) spreads, in points
 *
 * Percentages are of the names in the group that HAVE that lens (a stock
 * with under 200 daily bars is not counted against its group). Clicking a
 * row filters the stock table to that group. No arithmetic beyond counting
 * happens here; every per-stock flag comes from the API.
 */

export type GroupLevel = "sector" | "industry";

export interface GroupRoll {
  key: string;
  n: number;
  maN: number; maBull: number; maBear: number;
  revN: number; revBull: number; revBear: number; revTrig: number;
  stN: number; st2: number; st34: number; breakouts: number;
  /** Mean of the three bull−bear spreads, percentage points. */
  net: number | null;
}

type SortKey = "key" | "n" | "ma" | "rev" | "revTrig" | "stage" | "breakouts" | "net";

const COLUMNS: SortColumn<SortKey>[] = [
  { key: "key", label: "Group", num: false },
  { key: "n", label: "Names", num: true },
  { key: "ma", label: "MA stack · bull / bear", num: true, title: "Share with 10>20>50>200 vs the reverse (Lens 1)" },
  { key: "rev", label: "Reversal · bull / bear", num: true, title: "Share with a bullish vs bearish reversal state (Lens 2)" },
  { key: "revTrig", label: "Triggered", num: true, title: "Bullish reversals triggered within 2 bars" },
  { key: "stage", label: "Stage 2 / 3+4", num: true, title: "Share in Stage 2 vs Stages 3 and 4 (Lens 3)" },
  { key: "breakouts", label: "Brk", num: true, title: "Stage 2 breakouts" },
  { key: "net", label: "Net", num: true, title: "Mean of the three bull − bear spreads, in points" },
];

const pct = (k: number, n: number) => (n ? Math.round((100 * k) / n) : null);

export function rollUp(rows: SwingRow[], level: GroupLevel): GroupRoll[] {
  const m = new Map<string, GroupRoll>();
  for (const r of rows) {
    const key = (level === "sector" ? r.sector : r.industry) || "—";
    let g = m.get(key);
    if (!g) { g = { key, n: 0, maN: 0, maBull: 0, maBear: 0, revN: 0, revBull: 0, revBear: 0, revTrig: 0, stN: 0, st2: 0, st34: 0, breakouts: 0, net: null }; m.set(key, g); }
    g.n++;
    if (r.ma && r.ma.stack !== "n/a") { g.maN++; if (r.ma.stack === "bull") g.maBull++; else if (r.ma.stack === "bear") g.maBear++; }
    if (r.reversal?.state) {
      g.revN++;
      if (r.reversal.state.startsWith("bull")) g.revBull++; else g.revBear++;
      if (r.reversal.state === "bull-triggered") g.revTrig++;
    }
    if (r.stage?.stage) {
      g.stN++;
      if (r.stage.stage === 2) g.st2++; else if (r.stage.stage >= 3) g.st34++;
      if (r.stage.breakout) g.breakouts++;
    }
  }
  for (const g of m.values()) {
    const spreads: number[] = [];
    if (g.maN) spreads.push((100 * (g.maBull - g.maBear)) / g.maN);
    if (g.revN) spreads.push((100 * (g.revBull - g.revBear)) / g.revN);
    if (g.stN) spreads.push((100 * (g.st2 - g.st34)) / g.stN);
    g.net = spreads.length ? Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length) : null;
  }
  return [...m.values()];
}

function sortValue(g: GroupRoll, key: SortKey): number | string | null {
  switch (key) {
    case "key": return g.key;
    case "n": return g.n;
    case "ma": return g.maN ? (g.maBull - g.maBear) / g.maN : null;
    case "rev": return g.revN ? (g.revBull - g.revBear) / g.revN : null;
    case "revTrig": return g.revTrig;
    case "stage": return g.stN ? (g.st2 - g.st34) / g.stN : null;
    case "breakouts": return g.breakouts;
    case "net": return g.net;
  }
}

/** Two-sided share bar: bull share to the right of centre, bear share to the left. */
function Spread({ bull, bear, n }: { bull: number; bear: number; n: number }) {
  if (!n) return <span className="text-dim">—</span>;
  const b = pct(bull, n)!, s = pct(bear, n)!;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className={`w-8 text-right ${s ? "text-signal-bear" : "text-dim"}`}>{s}%</span>
      <span className="relative inline-block w-24 h-2 bg-bg-secondary rounded overflow-hidden align-middle">
        <span className="absolute right-1/2 top-0 h-full bg-signal-bear/70" style={{ width: `${s / 2}%` }} />
        <span className="absolute left-1/2 top-0 h-full bg-signal-bull/70" style={{ width: `${b / 2}%` }} />
        <span className="absolute left-1/2 top-0 h-full w-px bg-border" />
      </span>
      <span className={`w-8 ${b ? "text-signal-bull" : "text-dim"}`}>{b}%</span>
    </span>
  );
}

export function SwingGroups({ rows, level, onLevel, activeKey, onPick }: {
  rows: SwingRow[];
  level: GroupLevel;
  onLevel: (l: GroupLevel) => void;
  /** The group currently filtering the table, if any. */
  activeKey: string;
  onPick: (key: string) => void;
}) {
  const [minNames, setMinNames] = useState<number>(level === "industry" ? 3 : 1);
  const groups = useMemo(() => rollUp(rows, level).filter((g) => g.n >= minNames), [rows, level, minNames]);
  const { rows: sorted, sortKey, sortDir, onSort } = useTableSort<GroupRoll, SortKey>(groups, sortValue, "net", "desc");
  const netTone = (v: number | null) => (v === null ? "text-dim" : v > 10 ? "text-signal-bull" : v < -10 ? "text-signal-bear" : "text-text-secondary");

  return (
    <div className="bg-bg-card border border-border rounded">
      <div className="flex items-center gap-2 flex-wrap px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
        <span className="card-header p-0 border-0">Groups</span>
        <span className="text-[10px] text-text-secondary normal-case">which group is more bullish than bearish, per lens</span>
        <span className="flex-1" />
        {(["sector", "industry"] as const).map((l) => (
          <button key={l} onClick={() => { onLevel(l); setMinNames(l === "industry" ? 3 : 1); }}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              level === l ? "bg-text-primary text-bg-primary border-text-primary" : "border-border text-text-secondary hover:text-text-primary"}`}>
            {l === "sector" ? "By sector" : "By industry"}
          </button>
        ))}
        {level === "industry" && (
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            min names
            <select value={minNames} onChange={(e) => setMinNames(Number(e.target.value))} className="bg-bg-primary border border-border rounded px-1 py-0.5 text-[10px] text-text-primary">
              {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <SortHeaderRow columns={COLUMNS} sortKey={sortKey} sortDir={sortDir} onSort={onSort}
              rowClass="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border"
              cellClass="px-2 py-1.5 font-semibold whitespace-nowrap" />
          </thead>
          <tbody>
            {sorted.map((g) => (
              <tr key={g.key} onClick={() => onPick(g.key)}
                className={`border-b border-border/40 last:border-b-0 cursor-pointer hover:bg-bg-secondary/50 ${activeKey === g.key ? "bg-bg-secondary" : ""}`}
                title={`click to ${activeKey === g.key ? "clear the" : "filter the table to this"} ${level}`}>
                <td className="px-2 py-1 whitespace-nowrap font-semibold max-w-[16rem] truncate">{g.key}</td>
                <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{g.n}</td>
                <td className="px-2 py-1 whitespace-nowrap"><Spread bull={g.maBull} bear={g.maBear} n={g.maN} /></td>
                <td className="px-2 py-1 whitespace-nowrap"><Spread bull={g.revBull} bear={g.revBear} n={g.revN} /></td>
                <td className="px-2 py-1 text-right tabular-nums">{g.revTrig ? <span className="text-signal-bull font-semibold">{g.revTrig}</span> : <span className="text-dim">·</span>}</td>
                <td className="px-2 py-1 whitespace-nowrap"><Spread bull={g.st2} bear={g.st34} n={g.stN} /></td>
                <td className="px-2 py-1 text-right tabular-nums">{g.breakouts ? <span className="text-signal-bull font-semibold">{g.breakouts}</span> : <span className="text-dim">·</span>}</td>
                <td className={`px-2 py-1 text-right tabular-nums font-semibold ${netTone(g.net)}`}>{g.net === null ? "—" : `${g.net > 0 ? "+" : g.net < 0 ? "−" : ""}${Math.abs(g.net)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-dim">
        Bars read bear share to the left of centre and bull share to the right. Shares are of the names in the group that have that lens. Net is the mean of the three bull − bear spreads.
      </div>
    </div>
  );
}
