import { useCallback, useEffect, useRef, useState } from "react";
import { requestTvAnalysis, getTvAnalysis } from "../services/api.js";
import type { TvAnalysisResponse, TvSignalRow } from "../types.js";

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

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

/** Sidecar polls every few seconds; beyond this a reading is not "live". */
const STALE_AFTER_SECONDS = 180;

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

export function TradingViewPage() {
  const [ticker, setTicker] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<TvAnalysisResponse | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => () => { cancelRef.current = true; }, []);

  const runAnalysis = useCallback(async (raw: string) => {
    const symbol = raw.toUpperCase().trim();
    if (!symbol) return;

    cancelRef.current = false;
    setSubmitted(symbol);
    setStatus("waiting");
    setMessage("Queued — waiting for the desktop sidecar…");
    setResult(null);

    let requestId: string;
    try {
      ({ requestId } = await requestTvAnalysis(symbol));
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Could not queue the request");
      return;
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cancelRef.current) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (cancelRef.current) return;
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
      "Timed out after 2 minutes. The desktop sidecar is probably not running, " +
      "or TradingView Desktop was opened without the CDP launcher.",
    );
  }, []);

  const stale = result != null && result.ageSeconds > STALE_AFTER_SECONDS;
  const embedSymbol = (submitted ?? "").replace(":", "%3A");

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

      {/* Chart — the widget renders independently of the sidecar, so it still
          shows something useful even when the desktop side is down. */}
      {submitted && (
        <div className="bg-bg-card border border-border rounded overflow-hidden">
          <iframe
            key={submitted}
            title={`TradingView chart — ${submitted}`}
            src={`https://s.tradingview.com/widgetembed/?symbol=${embedSymbol}&interval=10&theme=dark&style=1&hidesidetoolbar=1&withdateranges=1&saveimage=0`}
            className="w-full h-[420px] border-0"
            loading="lazy"
          />
        </div>
      )}

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
            <span className={`text-[10px] uppercase tracking-wider ml-auto ${stale ? "text-signal-bear font-bold" : "text-dim"}`}>
              {stale ? `STALE — ${result.ageSeconds}s old` : `${result.ageSeconds}s ago`}
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
