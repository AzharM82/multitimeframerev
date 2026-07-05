import { useEffect, useMemo, useState } from "react";
import type { UoaScanResponse, UoaSignal, UoaAggregate } from "../types.js";
import { getUoaSignals, getUoaDates } from "../services/api.js";

/* Unusual Options Activity — EOD scanner output from the UnusualOptions repo
   (GitHub Actions cron → uoa-signals blobs → /api/uoa-signals proxy).
   Contract-level fires: ~30 DTE, volume ≥100× its own 20-day average, gated by
   notional and (when the data plan provides OI) volume/OI. Warm newspaper theme. */

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t)}`;

type SideFilter = "ALL" | "C" | "P";
const RATIO_CHIPS = [0, 200, 500] as const;
const NOTIONAL_CHIPS = [0, 1_000_000] as const;

const fmtInt = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtUsd = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`;
const fmtRatio = (v: number) => `${v >= 100 ? Math.round(v) : v.toFixed(1)}×`;
const fmtExpiry = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
};

function Sparkline({ history, today }: { history: number[]; today: number }) {
  const pts = [...history.slice(-20), today];
  if (pts.length < 2) return <span className="text-dim">—</span>;
  const max = Math.max(...pts, 1);
  const w = 72, h = 18;
  const step = w / (pts.length - 1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block align-middle">
      <polyline points={line} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
      {/* today's point, emphasized */}
      <circle cx={w} cy={h - 2 - (pts[pts.length - 1] / max) * (h - 4)} r="2.5" fill="var(--color-signal-bear)" />
    </svg>
  );
}

function OiCell({ s, oiAvailable }: { s: UoaSignal; oiAvailable: boolean }) {
  if (!oiAvailable || s.vol_oi_ratio == null) {
    return <span className="text-[10px] uppercase tracking-wider text-dim border border-border rounded px-1.5 py-0.5">n/a</span>;
  }
  const conf = s.oi_confirmation;
  return (
    <span className="whitespace-nowrap">
      <span className="tabular-nums">{s.vol_oi_ratio.toFixed(1)}×</span>
      {conf && (
        <span
          className={`ml-1.5 text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded ${
            conf.tag === "CONFIRMED" ? "bg-emerald-100 text-emerald-800"
            : conf.tag === "FADED" ? "bg-red-100 text-red-700"
            : "bg-amber-100 text-amber-800"
          }`}
        >
          {conf.tag}
        </span>
      )}
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-bg-card border border-border rounded p-3">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className="font-[var(--font-playfair)] text-xl font-bold mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

export function UnusualOptionsPage() {
  const [data, setData] = useState<UoaScanResponse | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [selDate, setSelDate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<SideFilter>("ALL");
  const [minRatio, setMinRatio] = useState<number>(0);
  const [minNotional, setMinNotional] = useState<number>(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    getUoaDates().then((r) => setDates(r.dates)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getUoaSignals(selDate || undefined)
      .then((r) => setData(r))
      .catch((e: Error) =>
        setError(e.message === "no_scan_data"
          ? "No scan data yet — the scanner runs after each market close."
          : e.message))
      .finally(() => setLoading(false));
  }, [selDate]);

  const oiAvailable = data?.oi_available !== false;

  const signals = useMemo(() => {
    if (!data) return [];
    return data.signals
      .filter((s) => side === "ALL" || s.type === side)
      .filter((s) => s.vol_ratio >= minRatio)
      .filter((s) => s.notional_premium >= minNotional);
  }, [data, side, minRatio, minNotional]);

  const aggregates: UoaAggregate[] = data?.aggregates ?? [];

  if (loading) return <div className="text-center py-16 text-text-secondary text-xs uppercase tracking-widest">Loading unusual options…</div>;

  if (error || !data) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="font-[var(--font-playfair)] text-lg font-bold mb-2">Unusual Options Activity</div>
        <p className="text-sm text-text-secondary">{error ?? "No data."}</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Scan date"
          value={fmtExpiry(data.scan_date)}
          sub={data.data_mode === "aggs" ? "aggs mode · OI unavailable" : "snapshot mode"}
        />
        <StatCard label="Universe" value={String(data.universe_size)} sub="underlyings scanned" />
        <StatCard label="Contracts scanned" value={fmtInt(data.contracts_scanned)} sub="25–35 DTE window" />
        <StatCard label="Signals fired" value={String(data.contracts_fired)} sub="≥100× 20d avg volume" />
      </div>

      {/* Filters + history */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["ALL", "C", "P"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSide(k)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              side === k ? "bg-text-primary text-bg-primary border-text-primary" : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {k === "ALL" ? "All" : k === "C" ? "Calls" : "Puts"}
          </button>
        ))}
        <span className="w-px h-4 bg-border mx-1" />
        {RATIO_CHIPS.map((r) => (
          <button
            key={r}
            onClick={() => setMinRatio(r)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              minRatio === r ? "bg-text-primary text-bg-primary border-text-primary" : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {r === 0 ? "Any ratio" : `≥ ${r}×`}
          </button>
        ))}
        <span className="w-px h-4 bg-border mx-1" />
        {NOTIONAL_CHIPS.map((n) => (
          <button
            key={n}
            onClick={() => setMinNotional(n)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              minNotional === n ? "bg-text-primary text-bg-primary border-text-primary" : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {n === 0 ? "Any premium" : "≥ $1M"}
          </button>
        ))}
        <span className="flex-1" />
        {dates.length > 0 && (
          <select
            value={selDate}
            onChange={(e) => setSelDate(e.target.value)}
            className="text-[11px] bg-bg-card border border-border rounded px-2 py-1"
          >
            <option value="">Latest</option>
            {dates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
      </div>

      {/* Signals table */}
      <div className="bg-bg-card border border-border rounded overflow-x-auto">
        <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">Contract-level signals</div>
        {signals.length === 0 ? (
          <div className="text-center py-10 text-xs text-text-secondary">
            No contracts passed every gate {side !== "ALL" || minRatio > 0 || minNotional > 0 ? "with these filters " : ""}on this scan.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
                <th className="text-left px-3 py-1.5">Contract</th>
                <th className="text-left px-2 py-1.5">Side</th>
                <th className="text-right px-2 py-1.5">DTE</th>
                <th className="text-right px-2 py-1.5">Vol</th>
                <th className="text-right px-2 py-1.5">20d avg</th>
                <th className="text-right px-2 py-1.5">Ratio</th>
                <th className="text-right px-2 py-1.5">Last</th>
                <th className="text-right px-2 py-1.5">Notional</th>
                <th className="text-center px-2 py-1.5">20d trend</th>
                <th className="text-right px-2 py-1.5">Score</th>
                <th className="text-left px-2 py-1.5">Vol/OI</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <SignalRow
                  key={s.occ_symbol}
                  s={s}
                  oiAvailable={oiAvailable}
                  expanded={expanded === s.occ_symbol}
                  onToggle={() => setExpanded(expanded === s.occ_symbol ? null : s.occ_symbol)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Underlying-level aggregates */}
      {aggregates.length > 0 && (
        <div className="bg-bg-card border border-border rounded overflow-x-auto">
          <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
            Underlying aggregates <span className="font-normal normal-case text-text-secondary">— in-window side volume ≥ 10× its 20d average</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
                <th className="text-left px-3 py-1.5">Underlying</th>
                <th className="text-left px-2 py-1.5">Side</th>
                <th className="text-right px-2 py-1.5">Agg volume</th>
                <th className="text-right px-2 py-1.5">20d avg</th>
                <th className="text-right px-2 py-1.5">Ratio</th>
                <th className="text-right px-3 py-1.5">Put/Call skew</th>
              </tr>
            </thead>
            <tbody>
              {aggregates.map((a) => (
                <tr key={`${a.underlying}-${a.side}`} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5">
                    <a href={TV(a.underlying)} target="_blank" rel="noreferrer" className="font-bold hover:underline">{a.underlying}</a>
                  </td>
                  <td className={`px-2 py-1.5 font-semibold ${a.side === "C" ? "text-signal-bull" : "text-signal-bear"}`}>
                    {a.side === "C" ? "CALL" : "PUT"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(a.agg_volume)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(a.agg_avg_20d)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{fmtRatio(a.agg_vol_ratio)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{a.put_call_skew == null ? "—" : a.put_call_skew.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[10px] uppercase tracking-wider text-text-secondary text-center pb-2">
        {data.data_delay_note}
      </div>
    </div>
  );
}

function SignalRow({
  s, oiAvailable, expanded, onToggle,
}: { s: UoaSignal; oiAvailable: boolean; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-border cursor-pointer hover:bg-bg-secondary transition-colors ${expanded ? "bg-bg-secondary" : ""}`}
      >
        <td className="px-3 py-1.5 whitespace-nowrap">
          <a
            href={TV(s.underlying)} target="_blank" rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-bold hover:underline"
          >
            {s.underlying}
          </a>{" "}
          <span className="tabular-nums">{fmtExpiry(s.expiry)} ${s.strike}{s.type}</span>
        </td>
        <td className={`px-2 py-1.5 font-semibold ${s.type === "C" ? "text-signal-bull" : "text-signal-bear"}`}>
          {s.type === "C" ? "CALL" : "PUT"}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{s.dte}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(s.today_volume)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">{fmtInt(s.avg_volume_20d)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold text-signal-bull">{fmtRatio(s.vol_ratio)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">${s.last_price.toFixed(2)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtUsd(s.notional_premium)}</td>
        <td className="px-2 py-1.5 text-center"><Sparkline history={s.volume_history} today={s.today_volume} /></td>
        <td className="px-2 py-1.5 text-right tabular-nums">{s.anomaly_score.toFixed(1)}</td>
        <td className="px-2 py-1.5"><OiCell s={s} oiAvailable={oiAvailable} /></td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-bg-secondary">
          <td colSpan={11} className="px-4 py-2.5">
            <div className="grid md:grid-cols-3 gap-3 text-[11px]">
              <div>
                <div className="text-[9px] uppercase tracking-wider text-text-secondary mb-1">Contract</div>
                <div className="tabular-nums">{s.occ_symbol}</div>
                <div className="text-text-secondary mt-0.5">raw 20d avg {s.avg_volume_20d_raw.toFixed(1)} · floored {fmtInt(s.avg_volume_20d)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-text-secondary mb-1">Open interest</div>
                {oiAvailable && s.prior_oi != null ? (
                  <div className="tabular-nums">prior OI {fmtInt(s.prior_oi)} · vol/OI {s.vol_oi_ratio?.toFixed(2) ?? "—"}
                    {s.oi_confirmation && <> · Δ next AM {fmtInt(s.oi_confirmation.oi_change)} → {s.oi_confirmation.tag}</>}
                  </div>
                ) : (
                  <div className="text-text-secondary">Not available on the current data plan — the vol/OI gate is skipped for this scan.</div>
                )}
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-text-secondary mb-1">Last 20 sessions (volume)</div>
                <div className="tabular-nums text-text-secondary break-words">{s.volume_history.slice(-20).map(fmtInt).join(" · ") || "—"}</div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
