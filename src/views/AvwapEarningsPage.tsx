import { useEffect, useMemo, useState } from "react";

/**
 * AVWAP from Earnings.
 *
 * The MASTER TradingView watchlist swept on DESKTOP2 against the 39-minute
 * chart. Per symbol, the distance from three levels:
 *
 *   AVWAP  "VWAP Auto Anchored", Anchor Period = Earnings (chart truth)
 *   21 EMA / 50 EMA   of 39m closes, computed by the publisher from the bars
 *
 * Positive = price above the level, negative = below.
 *
 * The alert rules this tab exists to make legible:
 *   - a candle CLOSING above any of the three levels, having closed below it on
 *     the previous candle  -> cross-up alert
 *   - a name extended ABOVE the AVWAP coming back down to touch it -> touch alert
 *
 * Everything therefore turns on the distance from ZERO, which is why the
 * "closest to a cross" block is pinned above the full list: those are the names
 * that can actually trigger next, on whichever level they are nearest.
 *
 * Distinct from the portal's other AVWAP work — that is session/swing anchored,
 * this is anchored to the last earnings report.
 */

const NEAR_PCT = 1.0;

type LevelKey = "avwap" | "ema21" | "ema50";

const LEVEL_LABEL: Record<LevelKey, string> = {
  avwap: "AVWAP",
  ema21: "21 EMA",
  ema50: "50 EMA",
};

interface Row {
  ticker: string;
  close: number;
  avwap: number;
  ema21: number | null;
  ema50: number | null;
  pctAvwap: number;
  pctEma21: number | null;
  pctEma50: number | null;
  lastCross: string;   // "<level>:<direction>", e.g. "ema21:CROSS_UP"
  lastCrossAt: string;
}

interface Snapshot {
  rows: Row[];
  barUtc: string;
  publishedAt: string;
  host: string;
  ageMin: number;
  stale: boolean;
  failed: string[];
  loaded: boolean;
}

const EMPTY: Snapshot = {
  rows: [], barUtc: "", publishedAt: "", host: "",
  ageMin: -1, stale: true, failed: [], loaded: false,
};

type SortKey = "avwap" | "ema21" | "ema50" | "ticker" | "close" | "nearest";
type SideFilter = "all" | "above" | "below";

async function fetchSnapshot(): Promise<Snapshot> {
  try {
    const res = await fetch("/api/avwap-earnings");
    if (!res.ok) return EMPTY;
    const raw = (await res.json()) as Record<string, unknown>;
    const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const rows = ((raw.rows ?? []) as Record<string, unknown>[]).map((r) => ({
      ticker: String(r.ticker ?? ""),
      close: Number(r.close ?? 0),
      avwap: Number(r.avwap ?? 0),
      ema21: nOrNull(r.ema21),
      ema50: nOrNull(r.ema50),
      pctAvwap: Number(r.pctAvwap ?? 0),
      pctEma21: nOrNull(r.pctEma21),
      pctEma50: nOrNull(r.pctEma50),
      lastCross: String(r.lastCross ?? ""),
      lastCrossAt: String(r.lastCrossAt ?? ""),
    }));
    return {
      rows,
      barUtc: String(raw.bar_utc ?? ""),
      publishedAt: String(raw.published_at ?? ""),
      host: String(raw.host ?? ""),
      ageMin: Number(raw.age_min ?? -1),
      stale: Boolean(raw.stale ?? true),
      failed: ((raw.failed ?? []) as unknown[]).map(String),
      loaded: true,
    };
  } catch {
    return EMPTY;
  }
}

function pctOf(r: Row, k: LevelKey): number | null {
  return k === "avwap" ? r.pctAvwap : k === "ema21" ? r.pctEma21 : r.pctEma50;
}

/** Which level this symbol sits closest to, and how far. Drives the "closest to a cross" block. */
function nearest(r: Row): { level: LevelKey; pct: number } | null {
  let best: { level: LevelKey; pct: number } | null = null;
  for (const k of ["avwap", "ema21", "ema50"] as LevelKey[]) {
    const p = pctOf(r, k);
    if (p === null) continue;
    if (!best || Math.abs(p) < Math.abs(best.pct)) best = { level: k, pct: p };
  }
  return best;
}

function pctTone(pct: number): string {
  if (pct >= 10) return "text-signal-bull";
  if (pct > 0) return "text-signal-bull/80";
  if (pct <= -10) return "text-signal-bear";
  if (pct < 0) return "text-signal-bear/80";
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

function CrossBadge({ row }: { row: Row }) {
  if (!row.lastCross) return null;
  const [level, dir] = row.lastCross.split(":");
  const label = LEVEL_LABEL[level as LevelKey] ?? level;
  if (dir === "CROSS_UP") {
    return (
      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-signal-bull/15 text-signal-bull">
        ▲ {label}
      </span>
    );
  }
  if (dir === "TOUCH_DOWN") {
    return (
      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-signal-bear/15 text-signal-bear">
        ▼ TOUCHED
      </span>
    );
  }
  return null;
}

/** Half-width max on each side of a centre rule. */
function DistanceBar({ pct, max }: { pct: number; max: number }) {
  const frac = max > 0 ? Math.min(Math.abs(pct) / max, 1) : 0;
  const width = `${(frac * 50).toFixed(1)}%`;
  return (
    <div className="relative h-2 w-full bg-bg-secondary rounded-sm overflow-hidden">
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className={`absolute inset-y-0 ${pct >= 0 ? "bg-signal-bull/60" : "bg-signal-bear/60"}`}
        style={pct >= 0 ? { left: "50%", width } : { right: "50%", width }}
      />
    </div>
  );
}

function PctCell({ pct }: { pct: number | null }) {
  if (pct === null) {
    // Not enough 39m history to seed the EMA — say so rather than print a 0
    // that reads as "sitting exactly on the level".
    return <td className="px-3 py-1.5 text-right tabular-nums text-dim">n/a</td>;
  }
  return (
    <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${pctTone(pct)}`}>
      {pct > 0 ? "+" : ""}{pct.toFixed(2)}%
    </td>
  );
}

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="bg-bg-card border border-border rounded px-4 py-3 min-w-[110px]">
      <div className="text-[11px] uppercase tracking-wide text-text-secondary">{label}</div>
      <div className={`text-2xl font-bold leading-tight mt-0.5 ${tone || "text-text-primary"}`}>{value}</div>
    </div>
  );
}

/**
 * `barOn` picks which level the distance bar visualises, and each table scales
 * its bars to ITS OWN widest row: scaling the near-a-cross table against the
 * full dataset's ±46% extreme renders every bar in it as an invisible sliver,
 * and that is precisely the table where relative distance matters most.
 */
function Table({ rows, barOn }: { rows: Row[]; barOn: LevelKey | "nearest" }) {
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary px-3 py-6">No symbols match.</p>;
  }
  const barPct = (r: Row): number | null =>
    barOn === "nearest" ? (nearest(r)?.pct ?? null) : pctOf(r, barOn);
  const max = rows.reduce((m, r) => Math.max(m, Math.abs(barPct(r) ?? 0)), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-text-secondary border-b border-border">
            <th className="text-left font-semibold px-3 py-2">Ticker</th>
            <th className="text-right font-semibold px-3 py-2">Close</th>
            <th className="text-right font-semibold px-3 py-2">AVWAP</th>
            <th className="text-right font-semibold px-3 py-2">Δ% AVWAP</th>
            <th className="text-right font-semibold px-3 py-2">Δ% 21 EMA</th>
            <th className="text-right font-semibold px-3 py-2">Δ% 50 EMA</th>
            {barOn === "nearest" && (
              <th className="text-left font-semibold px-3 py-2">Nearest</th>
            )}
            <th className="text-left font-semibold px-3 py-2 w-[22%]">Distance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const n = nearest(r);
            const bp = barPct(r);
            return (
              <tr key={r.ticker} className="border-b border-border/50 hover:bg-bg-secondary/50">
                <td className="px-3 py-1.5 font-bold text-text-primary whitespace-nowrap">
                  {r.ticker}<CrossBadge row={r} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-text-primary">{r.close.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-text-secondary">{r.avwap.toFixed(2)}</td>
                <PctCell pct={r.pctAvwap} />
                <PctCell pct={r.pctEma21} />
                <PctCell pct={r.pctEma50} />
                {barOn === "nearest" && (
                  <td className="px-3 py-1.5 text-[11px] text-text-secondary whitespace-nowrap">
                    {n ? LEVEL_LABEL[n.level] : "—"}
                  </td>
                )}
                <td className="px-3 py-1.5">
                  {bp === null ? <span className="text-dim text-xs">n/a</span>
                               : <DistanceBar pct={bp} max={max} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AvwapEarningsPage() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("avwap");

  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchSnapshot().then((s) => { if (alive) { setSnap(s); setLoading(false); } });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let rows = snap.rows;
    if (q) rows = rows.filter((r) => r.ticker.includes(q));
    if (side === "above") rows = rows.filter((r) => r.pctAvwap >= 0);
    if (side === "below") rows = rows.filter((r) => r.pctAvwap < 0);
    const sorted = [...rows];
    const byLevel = (k: LevelKey) => (a: Row, b: Row) =>
      (pctOf(b, k) ?? -Infinity) - (pctOf(a, k) ?? -Infinity);
    if (sortKey === "ticker") sorted.sort((a, b) => a.ticker.localeCompare(b.ticker));
    else if (sortKey === "close") sorted.sort((a, b) => b.close - a.close);
    else if (sortKey === "nearest") {
      sorted.sort((a, b) =>
        Math.abs(nearest(a)?.pct ?? Infinity) - Math.abs(nearest(b)?.pct ?? Infinity));
    } else sorted.sort(byLevel(sortKey));
    return sorted;
  }, [snap.rows, query, side, sortKey]);

  const near = useMemo(
    () => snap.rows
      .filter((r) => {
        const n = nearest(r);
        return n !== null && Math.abs(n.pct) <= NEAR_PCT;
      })
      .sort((a, b) => Math.abs(nearest(a)!.pct) - Math.abs(nearest(b)!.pct)),
    [snap.rows],
  );

  const above = snap.rows.filter((r) => r.pctAvwap >= 0).length;
  const below = snap.rows.length - above;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-black text-text-primary">AVWAP from Earnings</h2>
          <p className="text-xs text-text-secondary mt-0.5">
            MASTER watchlist · 39-minute chart · VWAP Auto Anchored (anchor = Earnings) + 21/50 EMA
          </p>
        </div>
        <div className="text-right text-[11px] text-text-secondary">
          <div>Bar: <span className="text-text-primary font-semibold">{fmtTime(snap.barUtc)}</span></div>
          <div>
            Published: {fmtTime(snap.publishedAt)}
            {snap.host && <span className="ml-1">· {snap.host}</span>}
            {snap.stale && snap.loaded && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-signal-bear/15 text-signal-bear">STALE</span>
            )}
          </div>
        </div>
      </div>

      {/* A feed that is down must never read as a quiet market. */}
      {!loading && !snap.loaded && (
        <div className="bg-signal-bear/10 border border-signal-bear/30 rounded px-3 py-2 text-xs text-signal-bear">
          Could not reach <code>/api/avwap-earnings</code>. This is a feed failure, not an empty
          market — nothing below is current.
        </div>
      )}
      {snap.loaded && snap.failed.length > 0 && (
        <div className="bg-bg-card border border-border rounded px-3 py-2 text-xs text-text-secondary">
          Publisher could not read {snap.failed.length} symbol(s): {snap.failed.join(", ")}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <Tile label="Symbols" value={snap.rows.length} />
        <Tile label="Above AVWAP" value={above} tone="text-signal-bull" />
        <Tile label="Below AVWAP" value={below} tone="text-signal-bear" />
        <Tile label={`Near a level (±${NEAR_PCT}%)`} value={near.length} />
      </div>

      <div className="bg-bg-card border border-border rounded">
        <div className="px-3 py-2 border-b border-border">
          <h3 className="text-sm font-bold text-text-primary">Closest to a cross (±{NEAR_PCT}%)</h3>
          <p className="text-[11px] text-text-secondary">
            Within {NEAR_PCT}% of AVWAP, 21 EMA or 50 EMA — a close on the far side of that level
            alerts. Ranked by the nearest level.
          </p>
        </div>
        {loading ? <p className="text-sm text-text-secondary px-3 py-6">Loading…</p>
                 : <Table rows={near} barOn="nearest" />}
      </div>

      <div className="bg-bg-card border border-border rounded">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-bold text-text-primary">All symbols</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter ticker…"
              className="bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary w-32"
            />
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as SideFilter)}
              className="bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary"
            >
              <option value="all">All</option>
              <option value="above">Above AVWAP</option>
              <option value="below">Below AVWAP</option>
            </select>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary"
            >
              <option value="avwap">Sort: Δ% AVWAP</option>
              <option value="ema21">Sort: Δ% 21 EMA</option>
              <option value="ema50">Sort: Δ% 50 EMA</option>
              <option value="nearest">Sort: nearest level</option>
              <option value="ticker">Sort: Ticker</option>
              <option value="close">Sort: Close</option>
            </select>
          </div>
        </div>
        {loading ? <p className="text-sm text-text-secondary px-3 py-6">Loading…</p>
                 : <Table rows={filtered} barOn={sortKey === "ema21" ? "ema21"
                                                : sortKey === "ema50" ? "ema50"
                                                : sortKey === "nearest" ? "nearest" : "avwap"} />}
      </div>
    </div>
  );
}
