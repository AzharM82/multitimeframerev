import { useCallback, useEffect, useRef, useState } from "react";
import { getOpeningDrive } from "../services/api.js";
import type { OpeningDriveResponse, OpeningDriveCandidate } from "../types.js";

/**
 * Opening Drive tab — SMB pre-market-high-break momentum.
 *
 * The 9:28 ET scan fills the candidate table; the cloud engine (Alpaca IEX)
 * stamps each row's live state through the 9:30–10:30 window. This view only
 * reads `/api/opening-drive-results` and auto-refreshes during the window, the
 * same polling shape as the Chart Analysis tab. No local machine involved.
 */

const REFRESH_MS = 15_000;

/** Today's date in ET as YYYY-MM-DD — matches the scan's partition scheme. */
function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Shift a YYYY-MM-DD string by n calendar days (UTC-anchored, DST-safe). */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function regimeTone(r: string | null): string {
  if (r === "GREEN") return "bg-signal-bull text-bg-primary";
  if (r === "RED") return "bg-signal-bear text-bg-primary";
  if (r === "YELLOW") return "bg-amber-500 text-bg-primary";
  return "bg-bg-secondary text-text-secondary";
}

function stateBadge(c: OpeningDriveCandidate): { label: string; cls: string } {
  switch (c.state) {
    case "TRIGGERED":
      return { label: "TRIGGERED", cls: "bg-signal-bull text-bg-primary font-bold" };
    case "EXIT":
      return { label: "EXIT", cls: "bg-signal-bear text-bg-primary" };
    case "STUFFED":
      return { label: "STUFFED", cls: "bg-amber-500 text-bg-primary" };
    case "GATE_FAIL":
      return { label: "ELIMINATED", cls: "bg-bg-secondary text-text-secondary line-through" };
    case "GATE_PASS":
      return { label: "WATCHING", cls: "bg-bg-secondary text-text-primary" };
    default:
      return { label: c.demoted ? "NO-CATALYST" : "PENDING", cls: "bg-bg-secondary text-dim" };
  }
}

function catalystTone(t: string): string {
  if (t === "NEWS") return "text-signal-bull";
  if (t === "ATH") return "text-amber-400";
  if (t === "BASE") return "text-text-secondary";
  return "text-dim";
}

function fmtMcap(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return String(v);
}

function CandidateRow({ c }: { c: OpeningDriveCandidate }) {
  const [open, setOpen] = useState(false);
  const badge = stateBadge(c);
  const dimmed = c.demoted || c.state === "GATE_FAIL";
  return (
    <>
      <tr
        className={`border-b border-border align-top ${dimmed ? "opacity-50" : ""} hover:bg-bg-secondary cursor-pointer`}
        onClick={() => setOpen((o) => !o)}
      >
        <td className="px-2 py-1.5 font-mono font-bold text-text-primary whitespace-nowrap">{c.ticker}</td>
        <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${badge.cls}`}>{badge.label}</span></td>
        <td className="px-2 py-1.5 font-mono text-signal-bull">+{c.gapPct.toFixed(1)}%</td>
        <td className="px-2 py-1.5 font-mono text-text-secondary">{c.pmHigh.toFixed(2)}</td>
        <td className="px-2 py-1.5 font-mono text-text-secondary">{c.ydayHigh.toFixed(2)}</td>
        <td className="px-2 py-1.5 font-mono text-text-secondary">{c.priorClose.toFixed(2)}</td>
        <td className="px-2 py-1.5 font-mono text-text-secondary">{c.ath ? "ATH" : c.roomOverheadPct != null ? `${c.roomOverheadPct.toFixed(1)}%` : "—"}</td>
        <td className="px-2 py-1.5 font-mono text-text-secondary">{c.atrPct.toFixed(1)}%</td>
        <td className="px-2 py-1.5 whitespace-nowrap">
          <span className={`font-semibold ${catalystTone(c.catalystType)}`}>{c.catalystType}</span>
          <span className="text-dim">/{c.catalystStrength}</span>
          {c.sectorSympathy && <span className="ml-1 text-[10px] text-amber-400">SYMP</span>}
        </td>
        <td className="px-2 py-1.5 font-mono text-text-secondary whitespace-nowrap">
          {c.sectorEtf ?? "—"}{c.sectorEtfPct != null && <span className={c.sectorEtfPct >= 0 ? "text-signal-bull" : "text-signal-bear"}> {c.sectorEtfPct >= 0 ? "+" : ""}{c.sectorEtfPct.toFixed(1)}%</span>}
        </td>
        <td className="px-2 py-1.5 font-mono text-dim">{fmtMcap(c.marketCap)}</td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-bg-secondary">
          <td colSpan={11} className="px-3 py-2 text-xs text-text-secondary">
            {c.state === "TRIGGERED" && (
              <div className="text-signal-bull font-mono mb-1">
                TRIGGERED {c.triggerBarEt} — entry {c.entry} / stop {c.stop}
                {c.riskPerShare != null && ` · risk ${c.riskPerShare.toFixed(2)}/sh`}
                {c.suggestedShares != null && ` · ~${c.suggestedShares} sh`}
                {c.rvol != null && ` · RVOL ${c.rvol.toFixed(1)}`}
              </div>
            )}
            {c.state === "EXIT" && <div className="text-signal-bear font-mono mb-1">EXIT — {c.exitReason}</div>}
            {c.catalystHeadline ? (
              <div>
                <span className="text-text-primary">{c.catalystHeadline}</span>
                {c.catalystSource && <span className="text-dim"> — {c.catalystSource}</span>}
                {c.catalystTimeEt && <span className="text-dim"> ({c.catalystTimeEt} ET)</span>}
              </div>
            ) : (
              <span className="text-dim italic">No fresh headline.</span>
            )}
            <div className="mt-1 text-dim font-mono">
              pm vol {Math.round(c.pmVolume).toLocaleString()} · pm last {c.pmLast.toFixed(2)} · sector {c.sector || "—"}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function OpeningDrivePage() {
  const [data, setData] = useState<OpeningDriveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // "" = today (live). A YYYY-MM-DD string reviews that day's saved history.
  const [viewDate, setViewDate] = useState("");
  const stopRef = useRef(false);

  const todayEt = etToday();
  const shownDate = viewDate || todayEt;
  const isLive = viewDate === "" || viewDate === todayEt;
  /** Pick a day; anything >= today snaps back to the live (today) view. */
  const selectDate = (d: string) => setViewDate(d && d < todayEt ? d : "");

  const load = useCallback(async () => {
    try {
      const res = await getOpeningDrive(viewDate || undefined);
      if (!stopRef.current) { setData(res); setError(null); }
    } catch (e) {
      if (!stopRef.current) setError(e instanceof Error ? e.message : "Could not load Opening Drive");
    } finally {
      if (!stopRef.current) setLoading(false);
    }
  }, [viewDate]);

  useEffect(() => {
    stopRef.current = false;
    setLoading(true);
    void load();
    // Only poll the live (today) view — historical days are static.
    const id = isLive ? setInterval(load, REFRESH_MS) : null;
    return () => { stopRef.current = true; if (id) clearInterval(id); };
  }, [load, isLive]);

  const candidates = data?.candidates ?? [];
  const triggered = candidates.filter((c) => c.state === "TRIGGERED").length;

  return (
    <div className="space-y-3">
      {/* Date navigator — browse saved history (each ET day is kept) */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <button
          onClick={() => selectDate(addDays(shownDate, -1))}
          className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-secondary"
          title="Previous day"
        >
          ◀
        </button>
        <input
          type="date"
          value={shownDate}
          max={todayEt}
          onChange={(e) => selectDate(e.target.value)}
          className="px-2 py-1 rounded border border-border bg-bg-card text-text-primary tabular-nums"
        />
        <button
          onClick={() => selectDate(addDays(shownDate, 1))}
          disabled={isLive}
          className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-secondary disabled:opacity-40"
          title="Next day"
        >
          ▶
        </button>
        {isLive ? (
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-signal-bull font-semibold">
            <span className="w-2 h-2 rounded-full bg-signal-bull animate-pulse" />
            Live · today
          </span>
        ) : (
          <>
            <button
              onClick={() => setViewDate("")}
              className="px-2.5 py-1 rounded bg-text-primary text-bg-primary text-[10px] font-semibold uppercase tracking-wider"
            >
              Back to live
            </button>
            <span className="text-[10px] uppercase tracking-wider text-amber-600">Reviewing history</span>
          </>
        )}
      </div>

      {/* Regime banner */}
      <div className="flex flex-wrap items-center gap-3 bg-bg-card border border-border rounded px-3 py-2.5">
        <span className={`px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider ${regimeTone(data?.regime ?? null)}`}>
          {data?.regime ?? "—"} regime
        </span>
        {data?.spyPct != null && (
          <span className="text-xs font-mono text-text-secondary">SPY {data.spyPct >= 0 ? "+" : ""}{data.spyPct.toFixed(2)}%</span>
        )}
        <span className="text-xs text-text-secondary">
          {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
          {triggered > 0 && <span className="text-signal-bull font-bold"> · {triggered} triggered</span>}
        </span>
        <span className="text-[10px] text-dim ml-auto">
          {data?.asOf ? `scan ${new Date(data.asOf).toLocaleTimeString()}` : ""}
        </span>
      </div>

      {error && <p className="text-xs text-signal-bear">{error}</p>}

      {loading && !data && <p className="text-xs text-text-secondary">Loading…</p>}

      {data && candidates.length === 0 && (
        <p className="text-xs text-text-secondary">
          {isLive
            ? "No candidates yet. The pre-market scan runs at 9:28 ET on trading days; the engine watches survivors for a pre-market-high break through 10:30 ET."
            : `No candidates were recorded for ${shownDate} — a weekend/holiday, or nothing cleared the gates that day.`}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="bg-bg-card border border-border rounded overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-text-secondary text-left">
                <th className="px-2 py-2">Ticker</th>
                <th className="px-2 py-2">State</th>
                <th className="px-2 py-2">Gap</th>
                <th className="px-2 py-2">PM High</th>
                <th className="px-2 py-2">Yday H</th>
                <th className="px-2 py-2">Prior C</th>
                <th className="px-2 py-2">Room</th>
                <th className="px-2 py-2">ATR%</th>
                <th className="px-2 py-2">Catalyst</th>
                <th className="px-2 py-2">Sector</th>
                <th className="px-2 py-2">Mkt Cap</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => <CandidateRow key={c.ticker} c={c} />)}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-dim">
        Universe: liquid gappers (price ≥ $50, avg $-vol ≥ $20M) with a catalyst. Live 2-min
        bars from Alpaca IEX. Click a row for the catalyst + trigger detail. Not financial advice.
      </p>
    </div>
  );
}
