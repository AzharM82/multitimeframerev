import { useEffect, useRef, useState } from "react";
import { getUoaLive } from "../../services/api.js";
import type { UoaBurst, UoaLiveResponse } from "../../types.js";

/**
 * Live flow — what just traded, while it is still worth knowing.
 *
 * The end-of-day scan is a record; this is the thing with a trade attached to
 * it. The engine polls Tradier every two minutes and reports the *increment*:
 * contracts that changed hands since the previous poll. Cumulative volume only
 * grows, so a day-total ratio fires late and cannot tell a name that traded
 * steadily from one that took a single enormous print at 10:14.
 *
 * Two honesty constraints are built into the display rather than bolted on:
 *
 *  - Open interest does not move intraday. OCC recomputes it overnight, so the
 *    denominator is yesterday's settlement all session and the column says so.
 *    A tab showing open interest "spiking" during the day would be inventing it.
 *  - Volume cannot be split into buys and sells. The tape reports a trade, not
 *    who initiated it. Where the last print sat against the spread is a lean,
 *    and it is labelled as one.
 */

const POLL_MS = 30_000;

const fmtInt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Math.round(n).toLocaleString();

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

/** Clock time in ET — the only timezone that means anything for a session. */
function fmtEt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York",
  });
}

function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 90) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

const tvUrl = (t: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t.replace("-", "."))}`;

/**
 * The lean, as a word rather than a colour alone.
 *
 * "bought" and "sold" are deliberately not styled as bullish/bearish: a bought
 * put and a bought call point opposite ways, and colouring the lean would imply
 * a direction the data does not carry.
 */
function SideChip({ side }: { side: UoaBurst["side"] }) {
  if (!side) return <span className="text-dim text-[10px]" title="No usable quote at the sample — the lean is unknown">?</span>;
  const label = side === "bought" ? "at ask" : side === "sold" ? "at bid" : "mid";
  const tone = side === "bought" ? "text-signal-bull" : side === "sold" ? "text-signal-bear" : "text-text-secondary";
  return (
    <span className={`text-[10px] ${tone}`}
      title={side === "mid"
        ? "The last print sat inside the spread — neither side clearly initiated"
        : `The last print sat at the ${side === "bought" ? "offer, which leans bought" : "bid, which leans sold"}. A lean, not a fact.`}>
      {label}
    </span>
  );
}

function BurstRow({ b, showTime }: { b: UoaBurst; showTime: boolean }) {
  return (
    <tr className="border-b border-border/40 hover:bg-bg-secondary/40">
      {showTime && <td className="px-2 py-1 tabular-nums text-text-secondary whitespace-nowrap">{fmtEt(b.at)}</td>}
      <td className="px-2 py-1 font-semibold whitespace-nowrap">
        <a href={tvUrl(b.underlying)} target="_blank" rel="noreferrer" className="hover:underline">{b.underlying}</a>
      </td>
      <td className={`px-2 py-1 font-bold ${b.type === "C" ? "text-signal-bull" : "text-signal-bear"}`}>
        {b.type === "C" ? "CALL" : "PUT"}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{fmtNum(b.strike, b.strike % 1 === 0 ? 0 : 2)}</td>
      <td className="px-2 py-1 text-text-secondary whitespace-nowrap">{b.expiry.slice(5)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-text-secondary">{b.dte}</td>
      <td className="px-2 py-1 text-right tabular-nums font-bold"
        title={`${fmtInt(b.lots)} contracts in the ${b.window_seconds ? `${Math.round(b.window_seconds / 60)}-minute` : ""} window`}>
        +{fmtInt(b.lots)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{fmtUsdShort(b.notional)}</td>
      <td className="px-2 py-1 text-right tabular-nums"
        title="This window's contracts as a share of yesterday's settled open interest">
        {b.oi_share >= 10 ? `${Math.round(b.oi_share)}x` : `${Math.round(b.oi_share * 100)}%`}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-text-secondary" title="Open interest at yesterday's settlement — it does not change during the day">
        {fmtInt(b.prior_oi)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-text-secondary" title="Contracts traded so far today">{fmtInt(b.day_volume)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-text-secondary"
        title={b.bid !== null && b.ask !== null ? `bid ${fmtNum(b.bid)} · ask ${fmtNum(b.ask)}` : undefined}>
        {fmtNum(b.last)}
      </td>
      <td className="px-2 py-1"><SideChip side={b.side} /></td>
    </tr>
  );
}

export function LiveFlow() {
  const [data, setData] = useState<UoaLiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [side, setSide] = useState<"all" | "C" | "P">("all");
  const [scope, setScope] = useState<"session" | "window">("session");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getUoaLive()
        .then((d) => { if (alive) { setData(d); setError(null); } })
        .catch((err) => { if (alive) setError(err instanceof Error ? err.message : "Could not load"); })
        .finally(() => { if (alive) setLoading(false); });
    };
    load();
    timer.current = window.setInterval(load, POLL_MS);
    return () => { alive = false; if (timer.current) window.clearInterval(timer.current); };
  }, []);

  const chip = (on: boolean) =>
    `px-2 py-0.5 rounded text-[11px] ${on ? "bg-text-primary text-bg-primary"
      : "border border-border text-text-secondary hover:text-text-primary"}`;

  const all = data ? (scope === "window" ? data.bursts : data.session) : [];
  const rows = all.filter((b) => side === "all" || b.type === side);
  const noData = !loading && !data;

  // Stale means the poll stopped, which is a different problem from a quiet
  // market and must not look like one.
  const stale = data ? Date.now() - new Date(data.updated_at).getTime() > 8 * 60_000 : false;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-secondary max-w-4xl">
        Contracts traded <span className="text-text-primary">since the previous poll</span>, not the day's total —
        so a single large print shows up the moment it happens instead of being averaged into a session figure.
        A burst is flagged when one window trades at least 15% of everything outstanding, or commits half a
        million dollars. Open interest is yesterday's settlement: OCC recomputes it overnight, so it does not
        move during the session and nothing here pretends otherwise. "At ask" and "at bid" are where the last
        print sat in the spread — a lean, not proof of who traded.
      </p>

      {noData && (
        <div className="bg-bg-card border border-gold rounded p-3 text-xs">
          <span className="font-bold text-gold">No live data yet. </span>
          <span className="text-text-secondary">
            The watch set is built at 8:40 AM ET and polling starts at the open. Outside market hours there is
            nothing to report — this is not an error.
          </span>
        </div>
      )}

      {error && !noData && (
        <div className="bg-bg-card border border-signal-bear rounded p-2 text-xs text-signal-bear">{error}</div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <button className={chip(scope === "session")} onClick={() => setScope("session")}>Today</button>
            <button className={chip(scope === "window")} onClick={() => setScope("window")}
              title="Only the most recent two-minute window">Last window</button>
            <span className="w-2" />
            <button className={chip(side === "all")} onClick={() => setSide("all")}>All</button>
            <button className={chip(side === "C")} onClick={() => setSide("C")}>Calls</button>
            <button className={chip(side === "P")} onClick={() => setSide("P")}>Puts</button>
            <span className={`text-[10px] ml-auto ${stale ? "text-signal-bear" : "text-dim"}`}
              title={`Poll #${data.seq}, ${data.quoted} of ${data.watchset_size} contracts quoted in ${data.elapsed_seconds}s`}>
              {stale ? "STALE · " : ""}updated {ago(data.updated_at)} · {fmtInt(data.watchset_size)} contracts watched
              {data.warming ? " · warming up" : ""}
            </span>
          </div>

          {data.warming && (
            <div className="bg-bg-card border border-border rounded p-2 text-[11px] text-text-secondary">
              First poll of the session. There is no earlier reading to compare against yet, so nothing is
              reported — otherwise every contract's whole morning would look like one burst. The next poll
              produces real numbers.
            </div>
          )}

          {rows.length === 0 && !data.warming ? (
            <div className="bg-bg-card border border-border rounded p-3 text-xs text-text-secondary">
              {scope === "window"
                ? "Nothing crossed the threshold in the last window. Switch to Today to see everything so far."
                : "No bursts yet today across the contracts being watched. That is a real answer — most windows are quiet."}
            </div>
          ) : (
            <div className="bg-bg-card border border-border rounded overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-text-secondary border-b border-border">
                    {scope === "session" && <th className="px-2 py-1.5 text-left font-semibold">ET</th>}
                    <th className="px-2 py-1.5 text-left font-semibold">Ticker</th>
                    <th className="px-2 py-1.5 text-left font-semibold">C/P</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Strike</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Expiry</th>
                    <th className="px-2 py-1.5 text-right font-semibold">DTE</th>
                    <th className="px-2 py-1.5 text-right font-semibold" title="Contracts traded in this window alone">Burst</th>
                    <th className="px-2 py-1.5 text-right font-semibold" title="Dollars committed in this window">Premium</th>
                    <th className="px-2 py-1.5 text-right font-semibold" title="The window as a share of yesterday's open interest">of OI</th>
                    <th className="px-2 py-1.5 text-right font-semibold" title="Open interest at yesterday's settlement">Open int.</th>
                    <th className="px-2 py-1.5 text-right font-semibold" title="Cumulative volume today">Day vol</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Last</th>
                    <th className="px-2 py-1.5 text-left font-semibold" title="Where the last print sat in the spread">Lean</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b, i) => (
                    <BurstRow key={`${b.occ_symbol}-${b.at}-${i}`} b={b} showTime={scope === "session"} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] text-dim">
            Watch set built {fmtEt(data.watchset_built_at)} ET · poll #{data.seq} ·
            {" "}{data.quoted} of {fmtInt(data.watchset_size)} contracts quoted in {data.elapsed_seconds}s ·
            {" "}refreshes every {POLL_MS / 1000}s. Mechanical signals, not investment advice.
          </p>
        </>
      )}
    </div>
  );
}
