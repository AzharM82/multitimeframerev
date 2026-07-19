import { useEffect, useState } from "react";
import type { GateScoreResponse, GateMode, GateCategory } from "../types.js";
import { getGateScore } from "../services/api.js";
import { useMarketHours } from "../hooks/useMarketHours.js";

/**
 * Gate — "should I be trading today?"
 *
 * Ported from the standalone ShouldIBeTrading app. Scores volatility, momentum,
 * trend, breadth and macro into a weighted quality score, applies two hard
 * overrides, and returns YES / CAUTION / NO plus a recommended posture.
 *
 * Verified at port time against the live source app: all eight scores and the
 * posture headline matched exactly in both day and swing modes.
 *
 * Rebuilt on the portal's own theme tokens rather than importing the source
 * app's CSS — that CSS defined a global `.newspaper-rule` and its own colour
 * variables, which would have silently re-skinned every other tab.
 */

const DECISION_STYLE: Record<string, string> = {
  YES: "text-signal-bull border-signal-bull bg-[#1a6b3c14]",
  CAUTION: "text-gold border-gold bg-[#8a6d1b14]",
  NO: "text-signal-bear border-signal-bear bg-[#a8221a14]",
};

const scoreTone = (s: number) =>
  s >= 65 ? "text-signal-bull" : s >= 40 ? "text-gold" : "text-signal-bear";

function CategoryCard({ name, cat }: { name: string; cat: GateCategory }) {
  return (
    <div className="bg-bg-card border border-border rounded p-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[9px] uppercase tracking-widest text-text-secondary">{name}</span>
        <span className="text-[9px] text-dim tabular-nums">{Math.round(cat.weight * 100)}%</span>
      </div>
      <div className={`font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums ${scoreTone(cat.score)}`}>
        {cat.score}
      </div>
      {/* Score bar — the weight is what makes a category matter, so show both. */}
      <div className="mt-2 h-1 bg-bg-secondary rounded-sm overflow-hidden">
        <div
          className={`h-full ${cat.score >= 65 ? "bg-signal-bull" : cat.score >= 40 ? "bg-gold" : "bg-signal-bear"}`}
          style={{ width: `${Math.max(0, Math.min(100, cat.score))}%` }}
        />
      </div>
      <div className="text-[10px] text-text-secondary mt-2 leading-snug">{cat.details}</div>
    </div>
  );
}

export function GatePage() {
  const [data, setData] = useState<GateScoreResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<GateMode>("day");
  const [tick, setTick] = useState(0);
  const marketOpen = useMarketHours();

  useEffect(() => {
    let cancelled = false;
    if (tick === 0) setLoading(true);
    setError(null);
    getGateScore(mode)
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mode, tick]);

  // Refresh while the market is open. The underlying feeds are delayed, so
  // there is nothing to gain from polling faster than a minute.
  useEffect(() => {
    if (!marketOpen) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [marketOpen]);

  if (loading) {
    return (
      <div className="text-center py-16 text-text-secondary text-xs uppercase tracking-widest">
        Scoring market …
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="font-[var(--font-playfair)] text-lg font-bold mb-2">Gate unavailable</div>
        <p className="text-sm text-text-secondary">{error ?? "No data."}</p>
      </div>
    );
  }

  const p = data.posture;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Mode toggle */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(["day", "swing"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              mode === m
                ? "bg-text-primary text-bg-primary border-text-primary"
                : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {m === "day" ? "Day Trading" : "Swing Trading"}
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => setTick((t) => t + 1)}
          className="px-2.5 py-1 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Degraded-feed warning. The original failed soft to zero here, which
          read as a spuriously bullish low-VIX market — so this is surfaced
          rather than swallowed. */}
      {data.dataQuality?.degraded && (
        <div className="border-l-2 border-gold bg-bg-secondary px-3 py-2 rounded-r">
          <div className="text-[10px] uppercase tracking-widest text-gold font-semibold mb-1">
            Degraded data feed
          </div>
          <ul className="text-[10.5px] text-text-secondary leading-snug list-disc pl-4">
            {data.dataQuality.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Verdict */}
      <div className="bg-bg-card border border-border rounded p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={`px-5 py-3 rounded border-2 font-[var(--font-playfair)] text-3xl font-black tracking-tight ${
              DECISION_STYLE[data.decision] ?? ""
            }`}
          >
            {data.decision}
          </div>
          <div className="flex gap-6">
            <div>
              <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-0.5">Quality</div>
              <div className={`font-[var(--font-playfair)] text-3xl font-black leading-none tabular-nums ${scoreTone(data.qualityScore)}`}>
                {data.qualityScore}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-0.5">Execution</div>
              <div className={`font-[var(--font-playfair)] text-3xl font-black leading-none tabular-nums ${scoreTone(data.executionScore)}`}>
                {data.executionScore}
              </div>
            </div>
          </div>
          <div className="flex-1 min-w-[220px]">
            <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1">Recommended posture</div>
            <div className="font-[var(--font-playfair)] text-base font-bold">{p.headline}</div>
            <div className="text-[10px] text-text-secondary mt-1">
              {p.bias} · {p.confidence} confidence · {p.sizePct}% size
            </div>
          </div>
        </div>

        {data.summary && (
          <p className="text-[11.5px] text-text-secondary mt-3 pt-3 border-t border-border leading-relaxed">
            {data.summary}
          </p>
        )}
        {p.rationale && (
          <p className="text-[11px] text-text-primary mt-2 leading-relaxed">{p.rationale}</p>
        )}
      </div>

      {/* Category breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <CategoryCard name="Volatility" cat={data.volatility} />
        <CategoryCard name="Momentum" cat={data.momentum} />
        <CategoryCard name="Trend" cat={data.trend} />
        <CategoryCard name="Breadth" cat={data.breadth} />
        <CategoryCard name="Macro" cat={data.macro} />
        <CategoryCard name="Execution" cat={data.execution} />
      </div>

      {/* Key levels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-bg-card border border-border rounded overflow-x-auto">
          <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">SPY</div>
          <table className="w-full text-xs">
            <tbody>
              {[
                ["Price", data.trend.spy.price],
                ["20-MA", data.trend.spy.ma20],
                ["50-MA", data.trend.spy.ma50],
                ["200-MA", data.trend.spy.ma200],
                ["RSI(14)", data.trend.spy.rsi14],
              ].map(([k, v]) => (
                <tr key={String(k)} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1 text-text-secondary">{k}</td>
                  <td className="text-right px-3 py-1 tabular-nums font-semibold">
                    {typeof v === "number" ? v.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-3 py-1 text-text-secondary">Regime</td>
                <td className="text-right px-3 py-1 font-semibold">{data.trend.spy.regime}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="bg-bg-card border border-border rounded overflow-x-auto">
          <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">Breadth &amp; Volatility</div>
          <table className="w-full text-xs">
            <tbody>
              {[
                ["% above 20-MA", `${data.breadth.above20d.toFixed(0)}%`],
                ["% above 50-MA", `${data.breadth.above50d.toFixed(0)}%`],
                ["% above 200-MA", `${data.breadth.above200d.toFixed(0)}%`],
                ["Adv/Dec ratio", data.breadth.advDeclineRatio.toFixed(2)],
                ["VIX", data.volatility.vix.level.toFixed(2)],
                ["VIX percentile (1y)", `${data.volatility.vix.percentile}%`],
                ["Sectors positive", `${data.momentum.pctPositive.toFixed(0)}%`],
              ].map(([k, v]) => (
                <tr key={String(k)} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1 text-text-secondary">{k}</td>
                  <td className="text-right px-3 py-1 tabular-nums font-semibold">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] uppercase tracking-wider text-text-secondary text-center pb-2">
        {marketOpen ? "Auto-refreshing every 60s" : "Market closed"} · Feeds delayed · Not financial advice
      </p>
    </div>
  );
}
