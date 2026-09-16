import { useEffect, useMemo, useState } from "react";
import { LiveFlow } from "./uoa/LiveFlow.js";
import { getUoaSignals, getUoaDates } from "../services/api.js";
import { useTableSort, SortHeaderRow, type SortColumn } from "./shared/tableSort.js";
import type { UoaScanResponse, UoaSignal } from "../types.js";

/**
 * Unusual Options — where the money went today.
 *
 * Its own tab, deliberately separate from the Options Guide. The Guide answers
 * "you picked a ticker, what spread should you place on it". This answers the
 * opposite question: nobody picked anything, so where is something happening.
 *
 * Two views, because "where is the money going" has two useful timeframes and
 * they need different rules:
 *
 *   Live        — contracts traded since the previous two-minute poll. The one
 *                 with a trade attached to it, and the default during the
 *                 session. See uoa/LiveFlow.tsx.
 *   End of day  — the whole session, swept once after the close. A record.
 *
 * The screen below is the end-of-day one, run across 127 optionable
 * names: today's contract volume against the open interest that existed at
 * yesterday's settlement. Volume above open interest means more contracts
 * changed hands than were outstanding — that is new positioning, not the same
 * contracts being passed between market makers. Everything else here (notional
 * committed, a minimum lot count, an open-interest floor) exists to keep dead
 * contracts from manufacturing enormous ratios out of nothing.
 *
 * The sweep runs in the cron Function App, not in the API, because Static Web
 * Apps cuts a managed request off at 45 seconds and the sweep takes four
 * minutes. This view only reads the blob it publishes.
 */

const tvUrl = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t.replace("-", "."))}`;

const fmtInt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Math.round(n).toLocaleString();

/** Money the way a trader reads it: $3.5M, not $3,539,102. */
function fmtUsdShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const fmtNum = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(d);

const fmtPct = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(0)}%`;

function fmtStamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

type Side = "all" | "C" | "P";
type Key =
  | "underlying" | "type" | "strike" | "expiry" | "dte" | "today_volume" | "prior_oi"
  | "vol_oi_ratio" | "notional_premium" | "last_price" | "iv" | "delta" | "anomaly_score";

const COLUMNS: SortColumn<Key>[] = [
  { key: "underlying", label: "Ticker", num: false },
  { key: "type", label: "C/P", num: false },
  { key: "strike", label: "Strike", num: true },
  { key: "expiry", label: "Expiry", num: false },
  { key: "dte", label: "DTE", num: true, title: "Calendar days to expiry" },
  { key: "today_volume", label: "Volume", num: true, title: "Contracts traded today" },
  { key: "prior_oi", label: "Open int.", num: true, title: "Contracts outstanding at yesterday's settlement" },
  { key: "vol_oi_ratio", label: "Vol/OI", num: true, title: "The headline test — above 1 means more traded today than existed yesterday" },
  { key: "notional_premium", label: "Premium", num: true, title: "Dollars committed: volume x price x 100" },
  { key: "last_price", label: "Last", num: true },
  { key: "iv", label: "IV", num: true, title: "Implied volatility" },
  { key: "delta", label: "Delta", num: true },
  { key: "anomaly_score", label: "Score", num: true, title: "Composite rank: dollars committed x vol/OI, and the 20-day ratio once there is history" },
];

function sortValue(r: UoaSignal, k: Key): number | string | null {
  switch (k) {
    case "underlying": return r.underlying;
    case "type": return r.type;
    case "expiry": return r.expiry;
    default: return (r[k] as number | null) ?? null;
  }
}

/** The call/put split for one name, as a bar you can read at a glance. */
function SplitBar({ call, put }: { call: number; put: number }) {
  const total = call + put;
  const pct = total > 0 ? (call / total) * 100 : 50;
  return (
    <div className="flex h-1.5 w-full rounded overflow-hidden bg-bg-secondary" title={`${fmtInt(call)} calls · ${fmtInt(put)} puts`}>
      <div className="bg-signal-bull" style={{ width: `${pct}%` }} />
      <div className="bg-signal-bear" style={{ width: `${100 - pct}%` }} />
    </div>
  );
}

function EodScan() {
  const [data, setData] = useState<UoaScanResponse | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("all");
  const [minRatio, setMinRatio] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    getUoaDates().then((d) => setDates(d.dates ?? [])).catch(() => setDates([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getUoaSignals(date || undefined)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((err) => { if (alive) { setData(null); setError(err instanceof Error ? err.message : "Could not load"); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [date]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (data?.signals ?? []).filter((s) => {
      if (side !== "all" && s.type !== side) return false;
      if (minRatio && (s.vol_oi_ratio ?? 0) < minRatio) return false;
      if (q && !s.underlying.includes(q)) return false;
      return true;
    });
  }, [data, side, minRatio, query]);

  const { rows, sortKey, sortDir, onSort } = useTableSort<UoaSignal, Key>(filtered, sortValue, "anomaly_score");

  const chip = (on: boolean) =>
    `px-2 py-0.5 rounded text-[11px] ${on ? "bg-text-primary text-bg-primary"
      : "border border-border text-text-secondary hover:text-text-primary"}`;

  // A scan that ran and found nothing is a completely different statement from
  // no scan at all, and the tab must never let the two look the same.
  const noScan = !loading && !data;
  const quietDay = !loading && data && (data.signals?.length ?? 0) === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {dates.length > 0 && (
          <select
            value={date || dates[0] || ""}
            onChange={(e) => setDate(e.target.value)}
            className="bg-bg-card border border-border rounded px-2 py-0.5 text-[11px] text-text-primary"
            title="Published scans, newest first">
            {dates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {loading && <span className="text-xs text-text-secondary">Loading…</span>}
        {data && (
          <span className="text-[10px] text-dim ml-auto">
            {data.feed ?? "scan"} {data.delayed === false ? "· real-time OPRA" : ""}
            {data.symbols_scanned ? ` · ${data.symbols_scanned}/${data.universe_size} symbols` : ""}
            {` · ${fmtInt(data.contracts_scanned)} live contracts`}
            {data.generated_at ? ` · swept ${fmtStamp(data.generated_at)} PT` : ""}
          </span>
        )}
      </div>

      <p className="text-[11px] text-text-secondary max-w-4xl">
        One test, run after the close: <span className="text-text-primary">today's volume against yesterday's open interest</span>.
        Above 3x means at least three times as many contracts changed hands today as were outstanding at settlement —
        new positioning rather than the same contracts circulating. Contracts 25–35 days out, within 25% of spot,
        at least 500 lots and $100k committed. The side shown is the contract type, not the direction of the trade:
        a bought call and a sold call look identical on the tape.
      </p>

      {error && !noScan && (
        <div className="bg-bg-card border border-signal-bear rounded p-2 text-xs text-signal-bear">{error}</div>
      )}

      {noScan && (
        <div className="bg-bg-card border border-gold rounded p-3 text-xs">
          <span className="font-bold text-gold">No scan published yet. </span>
          <span className="text-text-secondary">
            The sweep runs weekdays at 5:05 PM ET and writes one payload per session. If today was a trading day and
            this is still empty after 5:15, the cron Function App is the place to look, not the portal.
          </span>
        </div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <button className={chip(side === "all")} onClick={() => setSide("all")}>All</button>
            <button className={chip(side === "C")} onClick={() => setSide("C")}>Calls</button>
            <button className={chip(side === "P")} onClick={() => setSide("P")}>Puts</button>
            <span className="w-2" />
            {[0, 5, 10].map((r) => (
              <button key={r} className={chip(minRatio === r)} onClick={() => setMinRatio(r)}>
                {r === 0 ? "any ratio" : `${r}x+`}
              </button>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ticker"
              className="bg-bg-card border border-border rounded px-2 py-0.5 text-[11px] w-24 text-text-primary" />
            <span className="text-[10px] text-dim ml-auto">
              {rows.length} of {data.signals.length} shown
            </span>
          </div>

          {quietDay ? (
            <div className="bg-bg-card border border-border rounded p-3 text-xs text-text-secondary">
              The sweep ran across {fmtInt(data.contracts_scanned)} live contracts on {data.symbols_scanned ?? data.universe_size} names
              and nothing cleared the filters. That is a real answer, not a missing one — most sessions have no
              positioning loud enough to notice.
            </div>
          ) : (
            <div className="bg-bg-card border border-border rounded overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <SortHeaderRow columns={COLUMNS} sortKey={sortKey} sortDir={sortDir} onSort={onSort}
                    rowClass="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border"
                    cellClass="px-2 py-1.5 font-semibold whitespace-nowrap" />
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-text-secondary">
                      Nothing matches these filters. Widen the ratio, or clear the ticker box.
                    </td></tr>
                  )}
                  {rows.map((s) => (
                    <tr key={s.occ_symbol} className="border-b border-border/40 hover:bg-bg-secondary/40">
                      <td className="px-2 py-1 font-semibold whitespace-nowrap">
                        <a href={tvUrl(s.underlying)} target="_blank" rel="noreferrer"
                          className="hover:underline" title="Open in TradingView">{s.underlying}</a>
                      </td>
                      <td className={`px-2 py-1 font-bold ${s.type === "C" ? "text-signal-bull" : "text-signal-bear"}`}>
                        {s.type === "C" ? "CALL" : "PUT"}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmtNum(s.strike, s.strike % 1 === 0 ? 0 : 2)}
                        {s.spot ? <span className="text-dim text-[10px]" title={`spot ${fmtNum(s.spot)}`}>
                          {" "}{s.strike > s.spot ? "▲" : "▼"}
                        </span> : null}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-text-secondary">{s.expiry.slice(5)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{s.dte}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtInt(s.today_volume)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{fmtInt(s.prior_oi)}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-bold"
                        title={s.vol_ratio !== null
                          ? `Also ${fmtNum(s.vol_ratio, 0)}x its own ${s.baseline_days}-session average volume`
                          : `No stored volume history yet (${s.baseline_days} sessions) — the 20-day test is skipped, not failed`}>
                        {fmtNum(s.vol_oi_ratio, 1)}x
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtUsdShort(s.notional_premium)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-secondary"
                        title={s.bid !== null && s.ask !== null ? `bid ${fmtNum(s.bid)} · ask ${fmtNum(s.ask)}` : undefined}>
                        {fmtNum(s.last_price)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{fmtPct(s.iv)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{fmtNum(s.delta)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtNum(s.anomaly_score, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.aggregates?.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-[11px] uppercase tracking-wider text-text-secondary">
                Where the volume went · every name scanned, not just the signals
              </h3>
              <div className="bg-bg-card border border-border rounded overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border">
                      <th className="px-2 py-1.5 text-left font-semibold">Ticker</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Premium</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Calls</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Puts</th>
                      <th className="px-2 py-1.5 text-right font-semibold" title="Put volume divided by call volume — under 1 is call-heavy">P/C</th>
                      <th className="px-2 py-1.5 text-left font-semibold w-32">Split</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.aggregates.slice(0, 20).map((a) => (
                      <tr key={a.underlying} className="border-b border-border/40 hover:bg-bg-secondary/40">
                        <td className="px-2 py-1 font-semibold">
                          <a href={tvUrl(a.underlying)} target="_blank" rel="noreferrer" className="hover:underline">{a.underlying}</a>
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtUsdShort(a.notional)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-signal-bull">{fmtInt(a.call_volume)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-signal-bear">{fmtInt(a.put_volume)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtNum(a.put_call_ratio, 2)}</td>
                        <td className="px-2 py-1"><SplitBar call={a.call_volume} put={a.put_volume} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-dim">
            {data.data_note ?? data.data_delay_note}
            {data.elapsed_seconds ? ` Swept in ${data.elapsed_seconds}s.` : ""}
            {data.failed?.length ? ` ${data.failed.length} symbol(s) failed: ${data.failed.map((f) => f.symbol).join(", ")}.` : ""}
            {data.no_spot?.length ? ` No quote for ${data.no_spot.join(", ")}.` : ""}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The tab itself: the view switch, and nothing else.
 *
 * Live is the default because that is the question worth asking while the
 * market is open — an end-of-day list tells you where the money went after you
 * could do anything about it. The daily scan stays a click away as the record.
 */
export function UnusualOptionsPage() {
  const [view, setView] = useState<"live" | "eod">("live");
  const tab = (on: boolean) =>
    `px-2.5 py-0.5 rounded text-[11px] ${on ? "bg-text-primary text-bg-primary"
      : "border border-border text-text-secondary hover:text-text-primary"}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold tracking-tight">UNUSUAL OPTIONS</h2>
        <button className={tab(view === "live")} onClick={() => setView("live")}
          title="Bursts since the last two-minute poll">Live flow</button>
        <button className={tab(view === "eod")} onClick={() => setView("eod")}
          title="The whole session against yesterday's open interest">End of day</button>
      </div>
      {view === "live" ? <LiveFlow /> : <EodScan />}
    </div>
  );
}
