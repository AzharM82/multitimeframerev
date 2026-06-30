import { useEffect, useState, type ReactNode } from "react";
import type { CveResult, CveScanResponse, CveGrade, CveCatalystType } from "../types.js";
import { getCveScan } from "../services/api.js";

/* Catalyst Value Eval — CVE = Magnitude × Speed. Twice-daily snapshot (5 min
   before open, 10 min before close) of the top 3 bullish + top 3 bearish
   catalysts, filtered to B/A/A+. Populated by cve-timer; this view is read-only. */

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t)}`;

const GRADE_STYLE: Record<CveGrade, string> = {
  "A+": "bg-emerald-700 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-amber-500 text-white",
  C: "bg-slate-400 text-white",
  D: "bg-slate-300 text-slate-700",
};

const CATALYST_STYLE: Record<CveCatalystType, string> = {
  Fundamental: "bg-sky-500/15 text-sky-700 border-sky-500/40",
  Technical: "bg-violet-500/15 text-violet-700 border-violet-500/40",
  Combination: "bg-fuchsia-500/15 text-fuchsia-700 border-fuchsia-500/40",
  None: "bg-slate-500/10 text-slate-500 border-slate-400/40",
};

const RATING_STYLE: Record<string, string> = {
  Absolute: "text-emerald-700",
  Yes: "text-emerald-600",
  Maybe: "text-amber-600",
  No: "text-red-600",
};

const fmtMove = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtAge = (h: number | null) =>
  h == null ? "" : h < 1 ? "<1h ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;

function CatalystCard({ r }: { r: CveResult }) {
  return (
    <div className="rounded-lg border border-border bg-bg-card p-3.5 space-y-2 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <a href={TV(r.ticker)} target="_blank" rel="noopener" className="text-lg font-black text-text-primary hover:underline">
            {r.ticker}
          </a>
          <span className={`text-sm font-bold tabular-nums ${r.changePct >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>
            {fmtMove(r.changePct)}
          </span>
          <span className="text-[11px] text-dim tabular-nums">${r.price.toFixed(2)}</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`px-2 py-0.5 rounded text-xs font-black ${GRADE_STYLE[r.grade]}`}>{r.grade}</span>
          <span className="text-[10px] text-text-secondary font-semibold tabular-nums">{r.stopPct}% stop</span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${CATALYST_STYLE[r.catalystType]}`}>
          {r.catalystType}
        </span>
        <span className="font-mono text-xs">
          <span className={RATING_STYLE[r.magnitude.rating]}>{r.magnitude.rating}</span>
          <span className="text-dim"> × </span>
          <span className={RATING_STYLE[r.speed.rating]}>{r.speed.rating}</span>
          <span className="text-dim"> = </span>
          <span className="font-bold text-text-primary">{r.grade}</span>
        </span>
      </div>

      {r.headline && (
        <a href={r.newsUrl || TV(r.ticker)} target="_blank" rel="noopener" className="block text-[11px] text-text-secondary hover:text-text-primary leading-snug">
          “{r.headline}” <span className="text-dim">{fmtAge(r.newsAgeHours)}</span>
        </a>
      )}

      <p className="text-[11px] text-text-secondary leading-relaxed border-t border-border pt-2">{r.commentary}</p>
    </div>
  );
}

function Column({ title, accent, rows, empty }: { title: string; accent: string; rows: CveResult[]; empty: string }) {
  return (
    <div className="flex-1 min-w-0">
      <h2 className={`text-sm font-black uppercase tracking-widest mb-2 pb-1 border-b-2 ${accent}`}>{title}</h2>
      <div className="space-y-3">
        {rows.length ? rows.map((r) => <CatalystCard key={r.ticker} r={r} />) : (
          <div className="text-xs text-dim italic py-6 text-center">{empty}</div>
        )}
      </div>
    </div>
  );
}

function Methodology() {
  const Cell = ({ children, cls = "" }: { children: ReactNode; cls?: string }) => (
    <td className={`border border-border px-2 py-1 text-center tabular-nums ${cls}`}>{children}</td>
  );
  return (
    <details className="mt-6 rounded-lg border border-border bg-bg-card p-3 text-xs text-text-secondary">
      <summary className="cursor-pointer font-bold text-text-primary select-none">How the grade is computed — CVE = Magnitude × Speed</summary>
      <div className="mt-3 space-y-3 leading-relaxed">
        <p>
          Every in-play stock is rated on two axes. <b>Magnitude</b>: how big is the shift in perceived company value?
          <b> Speed</b>: how fast must the market act on it? Each axis scores <b>Absolute</b>, <b>Yes</b>, <b>Maybe</b>, or <b>No</b>.
        </p>
        <table className="border-collapse text-[11px]">
          <thead>
            <tr className="text-text-primary">
              <th className="border border-border px-2 py-1">Magnitude × Speed</th>
              <th className="border border-border px-2 py-1">Grade</th>
              <th className="border border-border px-2 py-1">Daily stop</th>
            </tr>
          </thead>
          <tbody>
            <tr><Cell>Absolute × Absolute</Cell><Cell cls="font-black text-emerald-700">A+</Cell><Cell>80%</Cell></tr>
            <tr><Cell>Yes × Yes</Cell><Cell cls="font-black text-emerald-600">A</Cell><Cell>30%</Cell></tr>
            <tr><Cell>Yes × Maybe / Maybe × Yes</Cell><Cell cls="font-black text-amber-600">B</Cell><Cell>15%</Cell></tr>
            <tr><Cell>Maybe × Maybe</Cell><Cell cls="font-black text-slate-500">C</Cell><Cell>minor</Cell></tr>
            <tr><Cell>any “No”</Cell><Cell cls="font-black text-red-600">D</Cell><Cell>0% — filtered</Cell></tr>
          </tbody>
        </table>
        <p>
          Only <b>B, A, A+</b> grades are shown. A bearish stock needs a <i>true negative catalyst</i> (surprise miss,
          product failure, regulatory action) — a drop that is merely the “absence of an expected positive” scores
          <b> No</b> on Magnitude and is filtered out. Catalyst type is <b>Fundamental</b> (earnings, FDA, M&A),
          <b> Technical</b> (index add/remove, lockups, options listing), or <b>Combination</b> (both at once).
        </p>
      </div>
    </details>
  );
}

const PHASE_LABEL: Record<string, string> = {
  open: "Pre-Open snapshot (15 min before open)",
  close: "Pre-Close snapshot (15 min before close)",
  manual: "Manual run",
};

export function CveEvalPage() {
  const [data, setData] = useState<CveScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCveScan()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center text-sm text-text-secondary py-12">Loading catalysts…</div>;

  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12 space-y-2">
        <p className="text-sm text-text-secondary">
          {error === "No CVE evaluation has run yet." || (error ?? "").includes("503")
            ? "No evaluation yet — the first snapshot runs 5 minutes before the next market open."
            : `Could not load: ${error}`}
        </p>
        <Methodology />
      </div>
    );
  }

  const generated = new Date(data.generated).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  return (
    <div className="max-w-5xl mx-auto">
      <div className="text-center mb-4">
        <h1 className="text-2xl font-black text-text-primary">Catalyst Value Eval</h1>
        <p className="text-xs text-text-secondary mt-0.5">
          CVE = Magnitude × Speed · {PHASE_LABEL[data.phase] ?? data.phase} · {generated} PT
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-5">
        <Column title="Top 3 Positive" accent="text-signal-bull border-signal-bull" rows={data.positives}
          empty="No bullish B/A/A+ catalysts in this window." />
        <Column title="Top 3 Negative" accent="text-signal-bear border-signal-bear" rows={data.negatives}
          empty="No bearish B/A/A+ catalysts in this window." />
      </div>

      <p className="text-center text-[10px] text-dim mt-5">
        Scanned {data.scanned} in-play names · {data.discovered} discovered
        (FinViz {data.sources.finviz}, Polygon movers {data.sources.polygonMovers}, news {data.sources.news})
      </p>

      <Methodology />
    </div>
  );
}
