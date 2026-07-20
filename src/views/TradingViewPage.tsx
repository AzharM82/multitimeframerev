import { useCallback, useEffect, useRef, useState } from "react";
import { requestTvAnalysis, getTvAnalysis, getTvHistory } from "../services/api.js";
import type { TvAnalysisResponse, TvSignalRow, TvHistoryPoint } from "../types.js";

/**
 * TradingView chart analysis tab.
 *
 * Type a ticker; the desktop sidecar (tools/tv-sidecar) reads that symbol off
 * TradingView Desktop, scores it against the weighted rubric, and publishes the
 * result. This page never computes signals - it only requests and renders.
 *
 * The round trip is mailbox-style because the cloud cannot reach the desktop:
 * POST the request, then poll until a result carrying OUR requestId appears.
 * Matching on requestId matters - a stale result for the same ticker is
 * otherwise indistinguishable from a fresh one.
 */

const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 120_000;

/** How often to check for a refreshed reading once one is on screen. */
const LIVE_POLL_MS = 20_000;

/**
 * The sidecar re-reads the watched ticker every 10 minutes, so anything older
 * than a cycle and a half has missed a refresh and should not be presented as
 * current.
 */
const STALE_AFTER_SECONDS = 900;

function verdictTone(verdict: string): string {
  if (verdict.startsWith("BULLISH")) return "bg-signal-bull text-bg-primary";
  if (verdict.startsWith("BEARISH")) return "bg-signal-bear text-bg-primary";
  if (verdict.startsWith("COUNTER-TREND")) return "bg-amber-500 text-bg-primary";
  if (verdict === "FILTERED" || verdict === "ERROR") return "bg-text-secondary text-bg-primary";
  return "bg-bg-secondary text-text-primary";
}

function SignalTable({ title, rows, tone }: { title: string; rows: TvSignalRow[]; tone: "bull" | "bear" }) {
  const total = rows.reduce((a, r) => a + r.weight, 0);
  const accent = tone === "bull" ? "text-signal-bull" : "text-signal-bear";
  return (
    <div className="flex-1 min-w-[320px] bg-bg-card border border-border rounded">
      <div className="flex items-baseline justify-between px-3 py-2 border-b border-border">
        <h3 className={`text-xs font-bold uppercase tracking-wider ${accent}`}>{title}</h3>
        <span className="text-xs font-mono text-text-secondary">{total} pts</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-xs text-text-secondary italic">No signals on this side.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.signal}-${i}`} className="border-b border-border last:border-0 align-top">
                <td className={`px-2 py-1.5 font-mono font-bold w-8 ${accent}`}>{r.weight}</td>
                <td className="px-1 py-1.5 font-semibold text-text-primary whitespace-nowrap">{r.signal}</td>
                <td className="px-2 py-1.5 text-text-secondary font-mono text-[11px]">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Intraday net-score trend, one bar per 10-minute reading.
 *
 * Net = bullish weight - bearish weight, so the zero line is the flip between
 * a bullish and bearish reading and bar height is conviction. Bars are placed
 * by chronological order rather than on a real time axis: the sidecar watches
 * one ticker at a time, so gaps where it was watching something else are real
 * and are shown as absent bars, never interpolated into a smooth line.
 */
function TrendHistogram({ points }: { points: TvHistoryPoint[] }) {
  if (!points.length) return null;

  const maxAbs = Math.max(5, ...points.map((p) => Math.abs(p.net)));
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  const first = points[0];
  const last = points[points.length - 1];
  const netNow = last.net;
  const netThen = first.net;
  const drift = netNow - netThen;

  return (
    <div className="bg-bg-card border border-border rounded p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h3
          className="text-xs font-bold uppercase tracking-wider text-text-primary"
          title={
            "Structural net = bullish minus bearish weight, counting only signals derivable " +
            "from the chart's own bar history (levels, MAs, VWAP, oscillators). " +
            "Volume and relative-strength signals come from Pine tables, which keep no " +
            "history, so they are excluded from EVERY bar — backfilled and live alike — " +
            "to keep the series comparable. The cards above use the full rubric, so their " +
            "net will differ from the latest bar here."
          }
        >
          Intraday trend · structural net per 10m bar
        </h3>
        <span className="text-[10px] font-mono text-text-secondary">
          {points.length} bar{points.length === 1 ? "" : "s"} · {fmt(first.at)}–{fmt(last.at)} ·{" "}
          <span className={drift > 0 ? "text-signal-bull" : drift < 0 ? "text-signal-bear" : ""}>
            {drift > 0 ? "+" : ""}{drift} since open
          </span>
        </span>
      </div>

      <div className="relative flex items-stretch gap-[2px] h-[132px] w-full">
        {/* zero line */}
        <div className="absolute left-0 right-0 top-1/2 border-t border-border pointer-events-none" />
        {points.map((p) => {
          const pct = (Math.abs(p.net) / maxAbs) * 50; // half the box is one polarity
          const up = p.net > 0;
          return (
            <div
              key={p.bucket}
              className="relative flex-1 min-w-[3px] group"
              title={`${fmt(p.at)} — net ${p.net > 0 ? "+" : ""}${p.net} (bull ${p.bullScore} / bear ${p.bearScore})${p.price != null ? ` @ ${p.price}` : ""}\n${p.verdict}`}
            >
              <div
                className={`absolute left-0 right-0 rounded-[1px] ${
                  up ? "bg-signal-bull" : p.net < 0 ? "bg-signal-bear" : "bg-text-secondary"
                } opacity-80 group-hover:opacity-100 transition-opacity`}
                style={
                  p.net === 0
                    ? { top: "calc(50% - 1px)", height: "2px" }
                    : up
                      ? { bottom: "50%", height: `${pct}%` }
                      : { top: "50%", height: `${pct}%` }
                }
              />
            </div>
          );
        })}
      </div>

      <div className="flex justify-between mt-1 text-[10px] font-mono text-dim">
        <span>{fmt(first.at)}</span>
        <span>±{maxAbs} scale · structural signals only · hover a bar for detail</span>
        <span>{fmt(last.at)}</span>
      </div>
    </div>
  );
}

export function TradingViewPage() {
  const [ticker, setTicker] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<TvAnalysisResponse | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [history, setHistory] = useState<TvHistoryPoint[]>([]);
  const cancelRef = useRef(false);

  useEffect(() => () => { cancelRef.current = true; }, []);

  /**
   * Live refresh. The sidecar keeps re-reading the watched ticker and
   * republishes under the SAME requestId, so updates are detected by a changed
   * computedAt rather than a new id. Runs until a different ticker is
   * submitted, which is what makes this a monitor rather than a one-shot.
   */
  useEffect(() => {
    if (!submitted || !activeRequestId || status !== "done") return;
    let stopped = false;

    const tick = async () => {
      try {
        const res = await getTvAnalysis(submitted);
        if (stopped || res.requestId !== activeRequestId) return;
        setResult((prev) => (prev && prev.computedAt === res.computedAt ? prev : res));
      } catch {
        // Transient failure; the age badge will show the reading going stale.
      }
      try {
        const h = await getTvHistory(submitted);
        if (!stopped) setHistory(h.points);
      } catch {
        // History is supplementary — never let its absence blank the tables.
      }
    };

    const id = setInterval(tick, LIVE_POLL_MS);
    void tick();
    return () => { stopped = true; clearInterval(id); };
  }, [submitted, activeRequestId, status]);

  const runAnalysis = useCallback(async (raw: string) => {
    const symbol = raw.toUpperCase().trim();
    if (!symbol) return;

    cancelRef.current = false;
    setSubmitted(symbol);
    setStatus("waiting");
    setMessage("Queued — waiting for the desktop sidecar…");
    setResult(null);
    setHistory([]); // previous ticker's trend must not linger under a new one
    setActiveRequestId(null); // stop the previous ticker's live refresh

    let requestId: string;
    try {
      ({ requestId } = await requestTvAnalysis(symbol));
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Could not queue the request");
      return;
    }

    const startedAt = Date.now();
    const deadline = startedAt + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cancelRef.current) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (cancelRef.current) return;

      // Tell the user what is actually happening. A silent spinner for two
      // minutes is indistinguishable from a broken app.
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setMessage(
        elapsed < 8
          ? `Requested ${symbol} — desktop sidecar is reading the chart… (${elapsed}s)`
          : elapsed < 45
            ? `Still working (${elapsed}s). If TradingView was closed, the sidecar is launching it — that takes ~40s.`
            : `No response after ${elapsed}s. The sidecar may not be running, or TradingView was opened without the CDP launcher.`,
      );

      try {
        const res = await getTvAnalysis(symbol);
        // Only accept a result produced for THIS request.
        if (res.requestId === requestId) {
          if (res.error) {
            setStatus("error");
            setMessage(`Sidecar error: ${res.error}`);
            return;
          }
          setResult(res);
          setActiveRequestId(requestId); // hands over to the live-refresh effect
          setStatus("done");
          setMessage(null);
          return;
        }
      } catch {
        // 404 until the sidecar publishes — expected, keep polling.
      }
    }

    setStatus("error");
    setMessage(
      `Timed out after 2 minutes waiting for a result for "${symbol}". ` +
      "Check tools/tv-sidecar/sidecar.log — if it shows a published result, the " +
      "sidecar worked and the result was filed under a different key.",
    );
  }, []);

  const stale = result != null && result.ageSeconds > STALE_AFTER_SECONDS;

  return (
    <div className="space-y-4">
      {/* Ticker entry */}
      <form
        onSubmit={(e) => { e.preventDefault(); void runAnalysis(ticker); }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="Ticker — e.g. NSE:NIFTY or NBIS"
          className="px-3 py-2 rounded bg-bg-card border border-border text-sm text-text-primary
                     placeholder:text-text-secondary focus:outline-none focus:border-text-primary
                     font-mono w-64"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={status === "waiting" || !ticker.trim()}
          className="px-4 py-2 rounded bg-text-primary text-bg-primary text-xs font-bold uppercase
                     tracking-wider disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {status === "waiting" ? "Analysing…" : "Analyse"}
        </button>
        {result && (
          <button
            type="button"
            onClick={() => void runAnalysis(submitted ?? ticker)}
            disabled={status === "waiting"}
            className="px-3 py-2 rounded border border-border text-xs font-semibold uppercase
                       tracking-wider text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            Refresh
          </button>
        )}
      </form>

      {message && (
        <p className={`text-xs ${status === "error" ? "text-signal-bear" : "text-text-secondary"}`}>
          {message}
        </p>
      )}

      {/* No embedded chart by design.
          A TradingView widget iframe was tried and removed: it cannot resolve a
          bare ticker (asking for "NIFTY" silently rendered Apple Inc), it does
          not carry the user's indicator template, and it duplicates the real
          chart the sidecar is already driving in TradingView Desktop. Showing a
          second, different chart next to the numbers is worse than showing
          none. The resolved symbol in the verdict bar is the confirmation that
          the right instrument was read. */}

      {/* Verdict */}
      {result && (
        <>
          <div className="flex flex-wrap items-center gap-3 bg-bg-card border border-border rounded px-3 py-2.5">
            <span className={`px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider ${verdictTone(result.verdict)}`}>
              {result.verdict}
            </span>
            <span className="text-sm font-mono font-bold text-text-primary">
              {result.symbol} {result.price ?? "—"}
            </span>
            <span className="text-xs font-mono text-text-secondary">
              bull {result.bullScore} / bear {result.bearScore} · net {result.net > 0 ? "+" : ""}{result.net}
            </span>
            <span className="text-xs text-text-secondary">
              daily bias: <strong className="text-text-primary">{result.dailyBias ?? "none"}</strong>
            </span>
            <span className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider ml-auto ${stale ? "text-signal-bear font-bold" : "text-dim"}`}>
              {!stale && <span className="w-1.5 h-1.5 rounded-full bg-signal-bull animate-pulse" />}
              {stale
                ? `STALE — ${Math.floor(result.ageSeconds / 60)}m old, sidecar may be down`
                : `WATCHING · updated ${result.ageSeconds < 60 ? `${result.ageSeconds}s` : `${Math.floor(result.ageSeconds / 60)}m`} ago`}
            </span>
          </div>

          {result.gateFailures.length > 0 && (
            <p className="text-xs text-signal-bear">
              Gate failures: {result.gateFailures.join("; ")}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <SignalTable title="Bullish" rows={result.bullish} tone="bull" />
            <SignalTable title="Bearish" rows={result.bearish} tone="bear" />
          </div>

          <TrendHistogram points={history} />

          {result.meta && (
            <p className="text-[10px] text-dim">
              tab {result.meta.chartId ?? "?"} ·{" "}
              {result.meta.studiesPopulated ?? "?"}/{result.meta.totalStudies ?? "?"} indicators ·
              computed {new Date(result.computedAt).toLocaleTimeString()}
            </p>
          )}
        </>
      )}

      {status === "idle" && (
        <p className="text-xs text-text-secondary">
          Enter a ticker to load the chart and score it against the multi-timeframe rubric.
          Daily sets bias; the 10-minute chart sets timing.
        </p>
      )}
    </div>
  );
}
