import { useEffect, useState } from "react";
import type {
  MmPanelName,
  MmKeyMetricsData,
  MmBreadthData,
  MmScreenersData,
  MmMoversData,
  MmScreenerRow,
} from "../types.js";
import { getMmPanel } from "../services/api.js";

/**
 * Metrics — a single-scroll board. All four sections (Key Metrics, Breadth,
 * Screeners, Movers) render at once, so there is no top-level tab-hopping to
 * see everything. A pinned in-page nav jumps between them, and the only
 * in-section controls left are the selectors that genuinely switch data
 * (index group, screener, mover category).
 *
 * Each panel reads from its own cron-warmed cache (/api/mm-panel) and loads
 * independently — a panel that hasn't been computed shows "not computed yet"
 * without breaking the others.
 */

const PANELS: { key: MmPanelName; label: string; anchor: string }[] = [
  { key: "key-metrics", label: "Key Metrics", anchor: "mm-key-metrics" },
  { key: "breadth", label: "Breadth", anchor: "mm-breadth" },
  { key: "screeners", label: "Screeners", anchor: "mm-screeners" },
  { key: "movers", label: "Movers", anchor: "mm-movers" },
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

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-20 font-[var(--font-playfair)] text-lg font-bold border-b-2 border-text-primary pb-1"
    >
      {children}
    </h2>
  );
}

/** Compact inline pill selector — the only in-section control left. */
function Pills({ items, active, onSelect }: { items: string[]; active: number; onSelect: (i: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {items.map((t, i) => (
        <button
          key={t}
          onClick={() => onSelect(i)}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
            i === active
              ? "bg-text-primary text-bg-primary border-text-primary"
              : "border-border text-text-secondary hover:text-text-primary"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
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

type PanelState = { data: unknown; generated: string | null; error: string | null; loading: boolean };
const initPanel = (): PanelState => ({ data: null, generated: null, error: null, loading: true });

/** Per-section loading / unavailable node, or null when data is ready. */
function status(st: PanelState, label: string): React.ReactNode | null {
  if (st.loading) {
    return (
      <div className="text-center py-10 text-text-secondary text-[10px] uppercase tracking-widest">
        Loading {label} …
      </div>
    );
  }
  if (st.error || st.data === null) {
    return <div className="text-center py-10 text-xs text-text-secondary">{st.error ?? "No data."}</div>;
  }
  return null;
}

export function MetricsPage() {
  const [panels, setPanels] = useState<Record<MmPanelName, PanelState>>({
    "key-metrics": initPanel(),
    breadth: initPanel(),
    screeners: initPanel(),
    movers: initPanel(),
  });
  // Inline selectors — the only in-section controls that switch data.
  const [kmGroup, setKmGroup] = useState(0);
  const [scrCat, setScrCat] = useState(0);
  const [mvrCat, setMvrCat] = useState(0);

  // Load every panel in parallel; each settles independently.
  useEffect(() => {
    let cancelled = false;
    for (const p of PANELS) {
      getMmPanel<unknown>(p.key)
        .then((r) => {
          if (cancelled) return;
          setPanels((s) => ({ ...s, [p.key]: { data: r.data, generated: r.generated, error: null, loading: false } }));
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setPanels((s) => ({
            ...s,
            [p.key]: {
              data: null,
              generated: null,
              error:
                e.message === "no_panel_data"
                  ? "Not computed yet — filled by the scheduled refresh."
                  : e.message,
              loading: false,
            },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const generated =
    panels["key-metrics"].generated ??
    panels.breadth.generated ??
    panels.screeners.generated ??
    panels.movers.generated;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Pinned in-page nav — jump between sections without leaving the tab. */}
      <div className="sticky top-0 z-10 py-2 mb-2 bg-bg-primary border-b border-border flex items-center gap-1.5 flex-wrap">
        {PANELS.map((p) => (
          <a
            key={p.key}
            href={`#${p.anchor}`}
            className="px-2.5 py-1 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary hover:border-text-primary transition-colors"
          >
            {p.label}
          </a>
        ))}
        <span className="flex-1" />
        {generated && (
          <span className="text-[10px] uppercase tracking-wider text-text-secondary">
            Computed{" "}
            {new Date(generated).toLocaleString("en-US", {
              timeZone: "America/Los_Angeles",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            PT
          </span>
        )}
      </div>

      <div className="space-y-8">
        {/* KEY METRICS */}
        <section className="space-y-3">
          <SectionTitle id="mm-key-metrics">Key Metrics</SectionTitle>
          {(() => {
            const st = panels["key-metrics"];
            const s = status(st, "key metrics");
            if (s) return s;
            const d = st.data as MmKeyMetricsData;
            const groups = Object.values(d.groups ?? {});
            if (!groups.length) return <div className="text-center py-10 text-xs text-text-secondary">No groups.</div>;
            const active = groups[Math.min(kmGroup, groups.length - 1)];
            return (
              <>
                <Pills items={groups.map((g) => g.group)} active={Math.min(kmGroup, groups.length - 1)} onSelect={setKmGroup} />
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
          })()}
        </section>

        {/* BREADTH */}
        <section className="space-y-3">
          <SectionTitle id="mm-breadth">Breadth</SectionTitle>
          {(() => {
            const st = panels.breadth;
            const s = status(st, "breadth");
            if (s) return s;
            const d = st.data as MmBreadthData;
            const l = d.latest;
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {([
                    ["4% Up", l?.up4, "text-signal-bull"],
                    ["4% Down", l?.down4, "text-signal-bear"],
                    ["T2108", l?.t2108, ""],
                    ["S&P 500", l?.sp500, ""],
                  ] as Array<[string, number | undefined, string]>).map(([label, v, tone]) => (
                    <div key={label} className="bg-bg-card border border-border rounded p-3">
                      <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">{label}</div>
                      <div className={`font-[var(--font-playfair)] text-2xl font-black tabular-nums ${tone}`}>
                        {typeof v === "number" ? v.toLocaleString() : "—"}
                      </div>
                    </div>
                  ))}
                </div>
                <Card title="Breadth History" sub={`${d.history?.length ?? 0} sessions · newest first`}>
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
          })()}
        </section>

        {/* SCREENERS */}
        <section className="space-y-3">
          <SectionTitle id="mm-screeners">Screeners</SectionTitle>
          {(() => {
            const st = panels.screeners;
            const s = status(st, "screeners");
            if (s) return s;
            const d = st.data as MmScreenersData;
            const tabs: Array<[string, MmScreenerRow[]]> = [
              ["Qullamaggie", d.qullamaggie ?? []],
              ["Minervini", d.minervini ?? []],
              ["O'Neil", d.oneil ?? []],
            ];
            const idx = Math.min(scrCat, tabs.length - 1);
            const [label, rows] = tabs[idx];
            return (
              <>
                <Pills items={tabs.map(([t, r]) => `${t} (${r.length})`)} active={idx} onSelect={setScrCat} />
                <Card title={label} sub={`${rows.length} matches`}>
                  <TickerTable rows={rows} cols={SCREENER_COLS} />
                </Card>
              </>
            );
          })()}
        </section>

        {/* MOVERS */}
        <section className="space-y-3">
          <SectionTitle id="mm-movers">Movers</SectionTitle>
          {(() => {
            const st = panels.movers;
            const s = status(st, "movers");
            if (s) return s;
            const d = st.data as MmMoversData;
            const tabs: Array<[string, MmScreenerRow[]]> = [
              ["97 Club", d.club97 ?? []],
              ["9M+ Volume", d.m9m ?? []],
              ["20% Weekly", d.w20pct ?? []],
              ["4% Daily", d.d4pct ?? []],
            ];
            const idx = Math.min(mvrCat, tabs.length - 1);
            const [label, rows] = tabs[idx];
            return (
              <>
                <Pills items={tabs.map(([t, r]) => `${t} (${r.length})`)} active={idx} onSelect={setMvrCat} />
                <Card title={label} sub={`${rows.length} matches`}>
                  <TickerTable rows={rows} cols={SCREENER_COLS} />
                </Card>
              </>
            );
          })()}
        </section>
      </div>

      <p className="text-[10px] uppercase tracking-wider text-text-secondary text-center py-4">
        Data: FinViz Elite &amp; Stockbee · refreshed on a schedule, not on load
      </p>
    </div>
  );
}
