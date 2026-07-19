import { useEffect, useState } from "react";
import type {
  MmPanelName,
  MmKeyMetricsData,
  MmBreadthData,
  MmScreenersData,
  MmIndustry,
  MmMoversData,
  MmScreenerRow,
} from "../types.js";
import { getMmPanel } from "../services/api.js";

/**
 * Metrics — the five core panels ported from the standalone MarketMetrics app.
 *
 * Everything here reads from a cron-warmed cache (/api/mm-panel). Panels are
 * never computed on demand: Key Metrics alone issues dozens of paced FinViz
 * requests and takes minutes, well past the function timeout. A panel that has
 * never been computed returns 503, which renders as a clear "not computed yet"
 * rather than an error.
 */

const PANELS: { key: MmPanelName; label: string }[] = [
  { key: "key-metrics", label: "Key Metrics" },
  { key: "breadth", label: "Breadth" },
  { key: "industries", label: "Leading Industries" },
  { key: "screeners", label: "Screeners" },
  { key: "movers", label: "Movers" },
];

const TV = (t: string) => `https://www.tradingview.com/chart/?symbol=${t}`;

const pctTone = (v: number) =>
  v >= 60 ? "text-signal-bull" : v <= 40 ? "text-signal-bear" : "text-text-secondary";

/** Change values arrive as strings like "+4.21%" from FinViz. */
function changeTone(v: unknown): string {
  const s = String(v ?? "");
  if (s.startsWith("-")) return "text-signal-bear";
  if (/^\+?\d/.test(s)) return "text-signal-bull";
  return "text-text-secondary";
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border rounded overflow-x-auto">
      <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
        {title}
        {sub && <span className="font-normal normal-case text-text-secondary"> · {sub}</span>}
      </div>
      {children}
    </div>
  );
}

function TickerTable({ rows, cols }: { rows: MmScreenerRow[]; cols: Array<[string, string]> }) {
  if (!rows?.length) {
    return <div className="text-center py-8 text-xs text-text-secondary">No rows.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
          {cols.map(([, label], i) => (
            <th key={label} className={`px-2 py-1.5 ${i === 0 ? "text-left px-3" : "text-right"}`}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 50).map((r, i) => (
          <tr key={`${r.ticker}-${i}`} className="border-b border-border last:border-b-0 hover:bg-bg-secondary">
            {cols.map(([key], ci) => (
              <td
                key={key}
                className={`px-2 py-1 ${ci === 0 ? "px-3" : "text-right tabular-nums"} ${
                  key === "change" ? changeTone(r[key]) : ""
                }`}
              >
                {ci === 0 ? (
                  <a href={TV(r.ticker)} target="_blank" rel="noreferrer" className="font-bold hover:underline">
                    {r.ticker}
                  </a>
                ) : (
                  (r[key] as string) ?? "—"
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SCREENER_COLS: Array<[string, string]> = [
  ["ticker", "Ticker"],
  ["price", "Price"],
  ["change", "Change"],
  ["rel_vol", "Rel Vol"],
  ["volume", "Volume"],
];

export function MetricsPage() {
  const [panel, setPanel] = useState<MmPanelName>("key-metrics");
  const [data, setData] = useState<unknown>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSubTab(0);
    getMmPanel<unknown>(panel)
      .then((r) => {
        if (cancelled) return;
        setData(r.data);
        setGenerated(r.generated);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setData(null);
        setError(
          e.message === "no_panel_data"
            ? "Not computed yet — this panel is filled by the scheduled refresh."
            : e.message,
        );
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [panel]);

  const body = () => {
    if (loading) {
      return (
        <div className="text-center py-16 text-text-secondary text-xs uppercase tracking-widest">
          Loading {panel} …
        </div>
      );
    }
    if (error || data === null) {
      return (
        <div className="max-w-lg mx-auto text-center py-16">
          <div className="font-[var(--font-playfair)] text-lg font-bold mb-2">Panel unavailable</div>
          <p className="text-sm text-text-secondary">{error ?? "No data."}</p>
        </div>
      );
    }

    if (panel === "key-metrics") {
      const d = data as MmKeyMetricsData;
      const groups = Object.values(d.groups ?? {});
      if (!groups.length) return <div className="text-center py-10 text-xs text-text-secondary">No groups.</div>;
      const active = groups[Math.min(subTab, groups.length - 1)];
      return (
        <>
          <div className="flex items-center gap-1.5 flex-wrap mb-3">
            {groups.map((g, i) => (
              <button
                key={g.group}
                onClick={() => setSubTab(i)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                  i === subTab
                    ? "bg-text-primary text-bg-primary border-text-primary"
                    : "border-border text-text-secondary hover:text-text-primary"
                }`}
              >
                {g.group}
              </button>
            ))}
          </div>
          <Card title={active.group} sub="above / below, % above">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
                  <th className="text-left px-3 py-1.5">Metric</th>
                  <th className="text-right px-2 py-1.5">Above</th>
                  <th className="text-right px-2 py-1.5">Below</th>
                  <th className="text-right px-2 py-1.5">% Above</th>
                  <th className="px-3 py-1.5 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {active.rows.map((r) => (
                  <tr key={r.label} className="border-b border-border last:border-b-0 hover:bg-bg-secondary">
                    <td className="px-3 py-1.5">{r.label}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-signal-bull">{r.above}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-signal-bear">{r.below}</td>
                    <td className={`text-right px-2 py-1.5 tabular-nums font-semibold ${pctTone(r.pct)}`}>
                      {r.pct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="block h-1.5 bg-bg-secondary rounded-sm overflow-hidden">
                        <span
                          className="block h-full bg-signal-bull"
                          style={{ width: `${Math.max(0, Math.min(100, r.pct))}%` }}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      );
    }

    if (panel === "breadth") {
      const d = data as MmBreadthData;
      const l = d.latest;
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              ["4% Up", l?.up4, "text-signal-bull"],
              ["4% Down", l?.down4, "text-signal-bear"],
              ["T2108", l?.t2108, ""],
              ["S&P 500", l?.sp500, ""],
            ].map(([label, v, tone]) => (
              <div key={String(label)} className="bg-bg-card border border-border rounded p-3">
                <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">{label}</div>
                <div className={`font-[var(--font-playfair)] text-2xl font-black tabular-nums ${tone}`}>
                  {typeof v === "number" ? v.toLocaleString() : "—"}
                </div>
              </div>
            ))}
          </div>
          <Card title="Breadth History" sub={`${d.history?.length ?? 0} sessions · oldest first`}>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
                  <th className="text-left px-3 py-1.5">Date</th>
                  <th className="text-right px-2 py-1.5">4% Up</th>
                  <th className="text-right px-2 py-1.5">4% Down</th>
                  <th className="text-right px-2 py-1.5">5d Ratio</th>
                  <th className="text-right px-2 py-1.5">10d Ratio</th>
                  <th className="text-right px-3 py-1.5">T2108</th>
                </tr>
              </thead>
              <tbody>
                {[...(d.history ?? [])].reverse().slice(0, 30).map((r) => (
                  <tr key={r.date} className="border-b border-border last:border-b-0 hover:bg-bg-secondary">
                    <td className="px-3 py-1">{r.date}</td>
                    <td className="text-right px-2 py-1 tabular-nums text-signal-bull">{r.up4}</td>
                    <td className="text-right px-2 py-1 tabular-nums text-signal-bear">{r.down4}</td>
                    <td className="text-right px-2 py-1 tabular-nums">{r.ratio5?.toFixed(2)}</td>
                    <td className="text-right px-2 py-1 tabular-nums">{r.ratio10?.toFixed(2)}</td>
                    <td className="text-right px-3 py-1 tabular-nums">{r.t2108?.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      );
    }

    if (panel === "industries") {
      // Defensive: the cached payload is produced by a separate timer, so a
      // shape change there must degrade to a readable message rather than
      // throwing mid-render (which blanks the tab).
      const list = Array.isArray(data) ? (data as MmIndustry[]) : [];
      if (list.length === 0) {
        return (
          <div className="max-w-lg mx-auto text-center py-16">
            <div className="font-[var(--font-playfair)] text-lg font-bold mb-2">No industries</div>
            <p className="text-sm text-text-secondary">
              The panel returned {Array.isArray(data) ? "an empty list" : `a ${typeof data}, not a list`}.
              It refreshes on the 17:30 ET timer.
            </p>
          </div>
        );
      }
      return (
        <Card title="Leading Industries" sub={`top ${list.length} by combined week + month RS`}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-text-secondary border-b border-border">
                <th className="text-left px-3 py-1.5">Industry</th>
                <th className="text-right px-2 py-1.5">Avg RS</th>
                <th className="text-left px-3 py-1.5">Leaders</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, ri) => (
                <tr key={`${r.industry}-${ri}`} className="border-b border-border last:border-b-0 hover:bg-bg-secondary">
                  <td className="px-3 py-1.5 font-semibold">{r.industry}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums">{typeof r.avg_rs === "number" ? r.avg_rs.toFixed(1) : "—"}</td>
                  <td className="px-3 py-1.5">
                    <span className="flex flex-wrap gap-1.5">
                      {(Array.isArray(r.tickers) ? r.tickers : []).filter((t) => t && t.ticker).map((t, ti) => (
                        <a
                          key={`${t.ticker}-${ti}`}
                          href={TV(t.ticker)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-baseline gap-1 hover:underline"
                        >
                          <span className="font-bold">{t.ticker}</span>
                          <span className={`text-[10px] ${changeTone(t.change)}`}>{t.change}</span>
                        </a>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      );
    }

    if (panel === "screeners") {
      const d = data as MmScreenersData;
      const tabs: Array<[string, MmScreenerRow[]]> = [
        ["Qullamaggie", d.qullamaggie ?? []],
        ["Minervini", d.minervini ?? []],
        ["O'Neil", d.oneil ?? []],
      ];
      const [label, rows] = tabs[Math.min(subTab, tabs.length - 1)];
      return (
        <>
          <div className="flex items-center gap-1.5 flex-wrap mb-3">
            {tabs.map(([t, r], i) => (
              <button
                key={t}
                onClick={() => setSubTab(i)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                  i === subTab
                    ? "bg-text-primary text-bg-primary border-text-primary"
                    : "border-border text-text-secondary hover:text-text-primary"
                }`}
              >
                {t} ({r.length})
              </button>
            ))}
          </div>
          <Card title={label} sub={`${rows.length} matches`}>
            <TickerTable rows={rows} cols={SCREENER_COLS} />
          </Card>
        </>
      );
    }

    const d = data as MmMoversData;
    const tabs: Array<[string, MmScreenerRow[]]> = [
      ["97 Club", d.club97 ?? []],
      ["9M+ Volume", d.m9m ?? []],
      ["20% Weekly", d.w20pct ?? []],
      ["4% Daily", d.d4pct ?? []],
    ];
    const [label, rows] = tabs[Math.min(subTab, tabs.length - 1)];
    return (
      <>
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {tabs.map(([t, r], i) => (
            <button
              key={t}
              onClick={() => setSubTab(i)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                i === subTab
                  ? "bg-text-primary text-bg-primary border-text-primary"
                  : "border-border text-text-secondary hover:text-text-primary"
              }`}
            >
              {t} ({r.length})
            </button>
          ))}
        </div>
        <Card title={label} sub={`${rows.length} matches`}>
          <TickerTable rows={rows} cols={SCREENER_COLS} />
        </Card>
      </>
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-1.5 flex-wrap">
        {PANELS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPanel(p.key)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              panel === p.key
                ? "bg-text-primary text-bg-primary border-text-primary"
                : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="flex-1" />
        {generated && (
          <span className="text-[10px] uppercase tracking-wider text-text-secondary">
            Computed {new Date(generated).toLocaleString("en-US", { timeZone: "America/New_York" })} ET
          </span>
        )}
      </div>

      {body()}

      <p className="text-[10px] uppercase tracking-wider text-text-secondary text-center pb-2">
        Data: FinViz Elite &amp; Stockbee · refreshed on a schedule, not on load
      </p>
    </div>
  );
}
