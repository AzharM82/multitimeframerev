/**
 * Options Strategy Guide — a plain-English credit-spread builder.
 *
 * Two strategies, deliberately no more:
 *   FLOOR BET   — bet it stays ABOVE a line (bull put spread)
 *   CEILING BET — bet it stays BELOW a line (bear call spread)
 *
 * The tab asks three questions in ordinary words and answers with a concrete
 * trade: the two orders to place, what you collect, what you can lose, where
 * you break even, and the checks that would stop a bad one.
 *
 * ── The view performs NO options arithmetic ───────────────────────────────
 * Every credit, max loss, breakeven, probability and payoff vertex arrives
 * precomputed from api/src/lib/spreadMath.ts, which is covered by
 * api/tools/spread-math-test.mjs. Sliding the safety line is an array lookup
 * into the ladder, not a recalculation — so there is exactly one implementation
 * of the money math and the chart can never disagree with the numbers beside it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { getOptionsExpiries, getOptionsSpread } from "../services/api.js";
import type {
  OptionsExpiriesResponse, OptionsSpreadResponse, SpreadRow, SpreadSide, SpreadCheck,
} from "../types.js";

const WIDTH_LABEL: Record<number, string> = {
  5: "Basic",
  10: "Full",
  20: "Max",
};

/** localStorage key for the one checklist item only the operator can answer. */
const ACK_KEY = "options_guide_ack";

const fmtUsd = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `$${v.toFixed(dp)}`;
const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(0)}%`;

function fmtAsOf(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

/** Glyph + tone for a checklist state. No icon library — the portal uses glyphs. */
function checkGlyph(state: string): { g: string; cls: string } {
  if (state === "pass") return { g: "✓", cls: "text-signal-bull" };
  if (state === "fail") return { g: "✗", cls: "text-signal-bear" };
  if (state === "warn") return { g: "!", cls: "text-gold" };
  return { g: "?", cls: "text-dim" };
}

function Tile({ label, value, sub, tone }: {
  label: string; value: string | number; sub?: string; tone?: string;
}) {
  return (
    <div className="bg-bg-card border border-border rounded px-3 py-2 min-w-[112px]">
      <div className="text-[10px] uppercase tracking-wide text-text-secondary">{label}</div>
      <div className={`text-xl font-bold leading-tight tabular-nums ${tone || "text-text-primary"}`}>{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

/**
 * The payoff diagram.
 *
 * Modelled on Timeline in SpyConvictionPage.tsx: same frame constants, clamping
 * scale closures, colour via Tailwind classes on the elements rather than
 * stroke=/fill= attributes.
 *
 * The profit and loss zones are shaded BY PRICE — two rects split at the
 * breakeven — rather than under the curve. The plain-English claim is "you win
 * if it stays above your line", and a price-axis band says exactly that.
 */
function PayoffChart({ row, spot, contracts }: { row: SpreadRow; spot: number; contracts: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = 200, L = 52, R = 18, TOP = 22, BOT = 140;

  // Scale the per-contract vertices to the position. Multiplying by an integer
  // is the only arithmetic done here — the SHAPE is the API's. Without this the
  // axis would read -$400 beside a tile reading -$2400 for the same trade.
  const n = Math.max(1, Math.floor(contracts) || 1);
  const pts = row.payoff.map((p) => ({ price: p.price, pl: p.pl * n }));
  if (!pts.length || row.credit === null || row.breakeven === null) return null;

  // The payoff vertices bound the strikes; spot can sit outside them (a name
  // that has run well above the short strike). Widen to include it AND leave a
  // margin, or the "now" marker lands exactly on the frame edge and its label
  // is clipped in half.
  const rawLo = Math.min(...pts.map((p) => p.price), spot);
  const rawHi = Math.max(...pts.map((p) => p.price), spot);
  const margin = (rawHi - rawLo) * 0.04 || 1;
  const lo = rawLo - margin;
  const hi = rawHi + margin;
  const span = hi - lo || 1;
  const x = (p: number) => L + ((Math.min(Math.max(p, lo), hi) - lo) / span) * (W - L - R);

  const profit = (row.maxProfitContract ?? 0) * n;
  const loss = (row.maxLossContract ?? 0) * n;
  const yMax = profit * 1.6 || 1;
  const yMin = -loss * 1.15 || -1;
  const y = (v: number) =>
    BOT - ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (BOT - TOP);

  /** P/L at any price, from the same four vertices the line is drawn from. */
  const plAt = (price: number) => {
    const k1 = Math.min(row.shortLeg.strike, row.longLeg.strike);
    const k2 = Math.max(row.shortLeg.strike, row.longLeg.strike);
    const left = pts[0].pl, right = pts[3].pl;
    if (price <= k1) return left;
    if (price >= k2) return right;
    return left + ((price - k1) / (k2 - k1)) * (right - left);
  };

  const be = row.breakeven;
  const winRight = row.side === "floor";
  const ticks = Array.from({ length: 6 }, (_, i) => lo + (span * i) / 5);

  return (
    <div className="overflow-x-auto">
      {/* The readout lives above the chart so it never occludes the curve. */}
      <div className="text-[11px] text-text-secondary h-4 mb-0.5">
        {hover !== null ? (
          <>
            at <span className="text-text-primary tabular-nums">${hover.toFixed(2)}</span>
            {" → "}
            <span className={`tabular-nums font-bold ${plAt(hover) >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>
              {plAt(hover) >= 0 ? "+" : "−"}${Math.abs(plAt(hover)).toFixed(0)}
            </span>
          </>
        ) : (
          <span className="text-dim">hover the chart to read profit or loss at any price</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]" role="img"
        aria-label={`Profit and loss at expiry for the ${row.side === "floor" ? "floor" : "ceiling"} bet`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          if (px < L || px > W - R) { setHover(null); return; }
          setHover(lo + ((px - L) / (W - L - R)) * span);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* Win / lose zones, split at the breakeven. */}
        <rect x={x(lo)} y={TOP} width={Math.max(0, x(be) - x(lo))} height={BOT - TOP}
          className={winRight ? "fill-signal-bear" : "fill-signal-bull"} opacity={0.10} />
        <rect x={x(be)} y={TOP} width={Math.max(0, x(hi) - x(be))} height={BOT - TOP}
          className={winRight ? "fill-signal-bull" : "fill-signal-bear"} opacity={0.10} />

        {/* P/L gridlines. Zero is heavier — it is the line that matters. */}
        {[profit, 0, -loss].map((v, i) => (
          <g key={i}>
            <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="currentColor"
              className={v === 0 ? "text-text-secondary" : "text-border"}
              strokeWidth={v === 0 ? 1 : 0.5} strokeDasharray={v === 0 ? undefined : "2 3"} />
            <text x={L - 5} y={y(v) + 3} textAnchor="end" fontSize={9}
              className={`fill-current ${v > 0 ? "text-signal-bull" : v < 0 ? "text-signal-bear" : "text-text-secondary"}`}>
              {v > 0 ? `+$${v.toFixed(0)}` : v < 0 ? `−$${Math.abs(v).toFixed(0)}` : "$0"}
            </text>
          </g>
        ))}

        {/* Price axis. */}
        {ticks.map((t, i) => (
          <text key={i} x={x(t)} y={BOT + 14} textAnchor="middle" fontSize={9}
            className="fill-current text-text-secondary">${t.toFixed(0)}</text>
        ))}

        {/* The payoff line itself — drawn from the vertices the API shipped. */}
        <polyline fill="none" stroke="currentColor" className="text-text-primary" strokeWidth={2}
          points={pts.map((p) => `${x(p.price)},${y(p.pl)}`).join(" ")} />

        {/* Markers.
            Labels are STAGGERED across two rows. The short strike and the
            breakeven sit within a credit's width of each other by definition —
            on a $1.00 credit that is a dollar apart — so a single label row
            renders them overlapping and unreadable. Sorting by price and
            alternating rows keeps neighbours apart whatever the spacing. */}
        {[
          { p: spot, cls: "text-text-primary", dash: "3 3", label: `now $${spot.toFixed(2)}` },
          { p: row.shortLeg.strike, cls: "text-accent", dash: undefined, label: `sell $${row.shortLeg.strike}` },
          { p: row.longLeg.strike, cls: "text-dim", dash: undefined, label: `buy $${row.longLeg.strike}` },
          { p: be, cls: "text-gold", dash: "2 2", label: `breakeven $${be.toFixed(2)}` },
        ]
          .slice()
          .sort((a, b) => a.p - b.p)
          .map((m, i) => (
            <g key={m.label}>
              <line x1={x(m.p)} y1={TOP - 6} x2={x(m.p)} y2={BOT + 4} stroke="currentColor"
                className={m.cls} strokeWidth={1} strokeDasharray={m.dash} />
              <text
                x={x(m.p)} y={i % 2 === 0 ? H - 20 : H - 7} fontSize={8.5}
                textAnchor={x(m.p) < L + 40 ? "start" : x(m.p) > W - R - 40 ? "end" : "middle"}
                className={`fill-current ${m.cls}`}>
                {m.label}
              </text>
              <title>{m.label}</title>
            </g>
          ))}

        {hover !== null && (
          <line x1={x(hover)} y1={TOP} x2={x(hover)} y2={BOT} stroke="currentColor"
            className="text-text-secondary" strokeWidth={0.5} opacity={0.6} />
        )}
      </svg>
    </div>
  );
}

function CheckRow({ label, check }: { label: string; check: SpreadCheck }) {
  const { g, cls } = checkGlyph(check.state);
  return (
    <div className="flex items-start gap-2 py-1 border-b border-border/40 last:border-0">
      <span className={`font-bold ${cls} w-4 text-center shrink-0`}>{g}</span>
      <span className="text-text-secondary w-40 shrink-0">{label}</span>
      <span className={`${cls}`}>{check.detail}</span>
    </div>
  );
}

export function OptionsGuidePage() {
  const [query, setQuery] = useState("");
  const [ticker, setTicker] = useState("");
  const [exp, setExp] = useState<OptionsExpiriesResponse | null>(null);
  const [expiration, setExpiration] = useState("");
  const [data, setData] = useState<OptionsSpreadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // The three questions.
  const [side, setSide] = useState<SpreadSide | null>(null);
  const [line, setLine] = useState("");
  const [widthTarget, setWidthTarget] = useState(5);
  const [ack, setAck] = useState(false);
  const [useAnyway, setUseAnyway] = useState(false);
  const [contracts, setContracts] = useState(1);
  const [riskBudget, setRiskBudget] = useState("");

  const loadTicker = useCallback(async (sym: string) => {
    const t = sym.trim().toUpperCase();
    if (!t) return;
    setLoading(true); setError(null); setErrorCode(null);
    setExp(null); setData(null); setSide(null); setLine(""); setUseAnyway(false);
    try {
      const e = await getOptionsExpiries(t);
      setExp(e); setTicker(t);
      setExpiration(e.recommended || e.expirations[0]?.date || "");
    } catch (err) {
      const m = err instanceof Error ? err.message : "Could not load";
      setError(m);
      setErrorCode(m);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ticker || !expiration) return;
    let alive = true;
    setLoading(true); setError(null);
    getOptionsSpread(ticker, expiration)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : "Could not load"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ticker, expiration]);

  /** Prefill the safety line from the 20–30 delta recommendation. */
  useEffect(() => {
    if (!data || !side) return;
    const rec = data.recommended[side];
    if (rec) setLine(String(rec.strike));
  }, [data, side]);

  const rows: SpreadRow[] = useMemo(() => {
    if (!data || !side) return [];
    return data.ladder[side]?.[`w${widthTarget}`] ?? [];
  }, [data, side, widthTarget]);

  /**
   * The chosen row. The safety line resolves to a short strike the same way the
   * server does — floor takes the highest strike at or below the line, ceiling
   * the lowest at or above — and then looks it up. No arithmetic, just a lookup.
   */
  const chosen: SpreadRow | null = useMemo(() => {
    if (!rows.length) return null;
    const v = Number(line);
    if (!Number.isFinite(v)) return null;
    const strikes = rows.map((r) => r.shortLeg.strike).sort((a, b) => a - b);
    const k = side === "floor"
      ? [...strikes].reverse().find((s) => s <= v)
      : strikes.find((s) => s >= v);
    if (k === undefined) return null;
    return rows.find((r) => r.shortLeg.strike === k) ?? null;
  }, [rows, line, side]);

  /**
   * The position at the chosen size.
   *
   * The API ships every figure PER CONTRACT, so this is pure scaling by an
   * integer — deliberately not a re-derivation. `capitalHeld` is the number the
   * broker actually withholds, and it equals max loss on a defined-risk
   * vertical; the credit is paid TO you, so nothing is "spent" to open.
   */
  const position = useMemo(() => {
    if (!chosen || chosen.maxProfitContract === null || chosen.maxLossContract === null) return null;
    const n = Math.max(1, Math.floor(contracts) || 1);
    return {
      contracts: n,
      creditReceived: chosen.maxProfitContract * n,
      capitalHeld: chosen.maxLossContract * n,
      maxProfit: chosen.maxProfitContract * n,
      maxLoss: chosen.maxLossContract * n,
    };
  }, [chosen, contracts]);

  /** How many contracts a risk budget buys. FLOORS — never size above budget. */
  const suggestedContracts = useMemo(() => {
    const b = Number(riskBudget);
    if (!chosen?.maxLossContract || !Number.isFinite(b) || b <= 0) return null;
    return Math.floor(b / chosen.maxLossContract);
  }, [chosen, riskBudget]);

  const ackKey = chosen && data
    ? `${data.ticker}|${data.expiration}|${chosen.side}|${chosen.shortLeg.strike}`
    : "";

  useEffect(() => {
    if (!ackKey) { setAck(false); return; }
    try {
      const raw = localStorage.getItem(ACK_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      setAck(Boolean(map[ackKey]));
    } catch { setAck(false); }
  }, [ackKey]);

  const toggleAck = () => {
    const next = !ack;
    setAck(next);
    if (!ackKey) return;
    try {
      const raw = localStorage.getItem(ACK_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (next) map[ackKey] = true; else delete map[ackKey];
      localStorage.setItem(ACK_KEY, JSON.stringify(map));
    } catch { /* a private window just means the box does not persist */ }
  };

  const liquidity: SpreadCheck | null = useMemo(() => {
    if (!chosen || !data) return null;
    const s = chosen.shortLeg, l = chosen.longLeg;
    const twoSided = (x: typeof s) => x.bid !== null && x.ask !== null && x.bid > 0 && x.ask > 0;
    if (!twoSided(s)) return { state: "fail", detail: "the leg you are selling has no bid" };
    if (!twoSided(l)) return { state: "fail", detail: "the protection leg has no offer" };
    if (s.openInterest === null || l.openInterest === null) {
      return { state: "unknown", detail: "open interest not reported" };
    }
    const thin = Math.min(s.openInterest, l.openInterest);
    if (thin < data.rules.min_open_interest) {
      return { state: "warn", detail: `open interest ${thin} — under ${data.rules.min_open_interest}` };
    }
    return { state: "pass", detail: `open interest ${thin}` };
  }, [chosen, data]);

  const overall = useMemo(() => {
    if (!data || !chosen || !liquidity) return null;
    const states = [data.checks.dte.state, data.checks.vix.state, liquidity.state];
    if (states.includes("fail")) return "FAIL";
    if (!ack) return "INCOMPLETE";
    if (states.includes("warn") || states.includes("unknown")) return "REVIEW";
    return "PASS";
  }, [data, chosen, liquidity, ack]);

  const isPut = side === "floor";
  const sideWord = isPut ? "Put" : "Call";

  // ─── Unconfigured / error states ─────────────────────────────────────────
  const notConfigured = errorCode?.includes("FINVIZ_API_KEY");
  const parseFailed = error?.toLowerCase().includes("payload") || error?.toLowerCase().includes("parse");

  return (
    <div className="space-y-3">
      <div>
        <h2 className="section-header text-lg">Options Strategy Guide</h2>
        <p className="text-xs text-text-secondary">
          Credit spreads in plain English · <span className="text-signal-bull">Floor Bet</span> = it stays above your line ·{" "}
          <span className="text-signal-bear">Ceiling Bet</span> = it stays below
          {data && (
            <>
              {" · "}
              <span className="text-dim">
                {data.feed} {data.delayed ? "· 15-min delayed" : "· live"}
                {data.as_of ? ` · as of ${fmtAsOf(data.as_of)} PT` : ""}
              </span>
            </>
          )}
        </p>
      </div>

      {/* Step 1 — the ticker */}
      <div className="bg-bg-card border border-border rounded p-3">
        <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1.5">
          1 · Which stock?
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); void loadTicker(query); }}
          className="flex items-center gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="AAPL"
            className="bg-bg-secondary border border-border rounded px-2 py-1 text-text-primary uppercase w-32"
          />
          <button type="submit"
            className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary">
            Load chain
          </button>
          {loading && <span className="text-xs text-text-secondary">Loading…</span>}
          {exp && (
            <span className="text-xs text-text-secondary">
              <span className="text-text-primary font-bold">{exp.ticker}</span>{" "}
              <span className="tabular-nums">${exp.spot.toFixed(2)}</span>
            </span>
          )}
        </form>
      </div>

      {notConfigured && (
        <div className="bg-bg-card border border-gold rounded p-3 text-xs">
          <div className="font-bold text-gold mb-1">Option chain not configured</div>
          <p className="text-text-secondary">
            <code className="text-text-primary">FINVIZ_API_KEY</code> is not set, so no chain can be fetched.
            The feed is chosen by <code className="text-text-primary">OPTIONS_FEED</code>{" "}
            (<code>finviz</code> by default, <code>alpaca</code> once an OPRA subscription exists).
          </p>
        </div>
      )}

      {parseFailed && (
        <div className="bg-bg-card border border-signal-bear rounded p-3 text-xs">
          <div className="font-bold text-signal-bear mb-1">The chain could not be read</div>
          <p className="text-text-secondary">
            The upstream page structure changed — the parser in{" "}
            <code className="text-text-primary">api/src/lib/finvizOptions.ts</code> needs updating.
            Nothing is shown rather than a partial chain, because half a chain becomes a wrong recommendation.
          </p>
          <p className="text-dim mt-1">{error}</p>
        </div>
      )}

      {error && !notConfigured && !parseFailed && (
        <div className="bg-bg-card border border-border rounded p-3 text-xs text-signal-bear">{error}</div>
      )}

      {/* Expiry picker */}
      {exp && (
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1.5">
            Expiry · the strategy wants {exp.dte_window[0]}–{exp.dte_window[1]} days out
          </div>
          {exp.expirations.length === 0 ? (
            <div className="text-xs">
              <div className="text-gold mb-1">
                Nothing expires between {exp.dte_window[0]} and {exp.dte_window[1]} days out.
              </div>
              <div className="text-text-secondary mb-1">
                Available: {exp.outside_window.slice(0, 10).map((e) => `${e.date} (${e.dte}d)`).join(" · ")}
              </div>
              <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer">
                <input type="checkbox" checked={useAnyway} onChange={() => setUseAnyway(!useAnyway)} />
                use one anyway — the checklist will flag the DTE
              </label>
              {useAnyway && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {exp.outside_window.slice(0, 12).map((e) => (
                    <button key={e.date} type="button" onClick={() => setExpiration(e.date)}
                      className={`px-2 py-0.5 rounded text-[11px] tabular-nums ${
                        expiration === e.date ? "bg-text-primary text-bg-primary" : "border border-border text-text-secondary hover:text-text-primary"}`}>
                      {e.date} <span className="text-[9px]">{e.dte}d</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {exp.expirations.map((e) => (
                <button key={e.date} type="button" onClick={() => setExpiration(e.date)}
                  title={e.monthly ? "monthly — deeper liquidity" : "weekly"}
                  className={`px-2 py-0.5 rounded text-[11px] tabular-nums ${
                    expiration === e.date
                      ? "bg-text-primary text-bg-primary"
                      : "border border-border text-text-secondary hover:text-text-primary"}`}>
                  {e.date} <span className="text-[9px]">{e.dte}d</span>
                  {e.ideal && <span className="text-[9px] ml-0.5">·</span>}
                  {e.monthly && <span className="text-[9px] ml-0.5">M</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 2 — direction */}
      {data && (
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1.5">
            2 · Where do you think {data.ticker} is going by {data.expiration}?
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSide("floor")}
              className={`px-3 py-2 rounded border text-left ${
                side === "floor" ? "border-signal-bull ring-1 ring-signal-bull" : "border-border hover:bg-bg-secondary"}`}>
              <div className="font-bold text-signal-bull text-sm">It stays ABOVE a line</div>
              <div className="text-[11px] text-text-secondary">Floor Bet · bullish or sideways</div>
            </button>
            <button type="button" onClick={() => setSide("ceiling")}
              className={`px-3 py-2 rounded border text-left ${
                side === "ceiling" ? "border-signal-bear ring-1 ring-signal-bear" : "border-border hover:bg-bg-secondary"}`}>
              <div className="font-bold text-signal-bear text-sm">It stays BELOW a line</div>
              <div className="text-[11px] text-text-secondary">Ceiling Bet · bearish or sideways</div>
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — the line and the protection */}
      {data && side && (
        <div className="bg-bg-card border border-border rounded p-3 space-y-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1.5">
              3 · Where is your line, and how much protection?
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={line} onChange={(e) => setLine(e.target.value)} inputMode="decimal"
                className="bg-bg-secondary border border-border rounded px-2 py-1 text-text-primary w-28 tabular-nums"
              />
              {data.recommended[side] && (
                <span className="text-[11px] text-text-secondary">
                  the math likes{" "}
                  <button type="button" onClick={() => setLine(String(data.recommended[side]!.strike))}
                    className="text-accent hover:underline tabular-nums">
                    ${data.recommended[side]!.strike}
                  </button>{" "}
                  <span className="text-dim">
                    ({(data.recommended[side]!.delta * 100).toFixed(0)}Δ
                    {data.recommended[side]!.inBand ? "" : " — outside the 20–30 target"})
                  </span>
                </span>
              )}
              {!data.greeks_available && (
                <span className="text-[11px] text-gold">
                  no greeks in this chain — pick by price, no delta recommendation is possible
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-text-secondary">Contracts</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setContracts((c) => Math.max(1, c - 1))}
                className="px-2 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary">−</button>
              <input
                value={contracts}
                onChange={(e) => {
                  const v = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
                  setContracts(Number.isFinite(v) && v > 0 ? v : 1);
                }}
                inputMode="numeric"
                className="bg-bg-secondary border border-border rounded px-2 py-1 text-text-primary w-16 text-center tabular-nums"
              />
              <button type="button" onClick={() => setContracts((c) => c + 1)}
                className="px-2 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary">+</button>
            </div>
            {/* Sizing from a risk budget, because "how many" is really "how much
                am I willing to lose". Floors, so it can never suggest a size
                that exceeds the budget. */}
            <span className="text-[11px] text-text-secondary">or risk at most</span>
            <input
              value={riskBudget} onChange={(e) => setRiskBudget(e.target.value)}
              placeholder="$500" inputMode="decimal"
              className="bg-bg-secondary border border-border rounded px-2 py-1 text-text-primary w-20 tabular-nums"
            />
            {suggestedContracts !== null && (
              suggestedContracts > 0 ? (
                <button type="button" onClick={() => setContracts(suggestedContracts)}
                  className="text-[11px] text-accent hover:underline">
                  → {suggestedContracts} contract{suggestedContracts === 1 ? "" : "s"}
                </button>
              ) : (
                <span className="text-[11px] text-gold">
                  one contract already risks {fmtUsd(chosen?.maxLossContract, 0)}
                </span>
              )
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {data.rules.widths.map((w) => (
              <button key={w} type="button" onClick={() => setWidthTarget(w)}
                className={`px-2 py-0.5 rounded text-[11px] ${
                  widthTarget === w ? "bg-text-primary text-bg-primary" : "border border-border text-text-secondary hover:text-text-primary"}`}>
                {WIDTH_LABEL[w] ?? `$${w}`} <span className="text-[9px]">${w} wide</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The answer */}
      {data && side && !chosen && line !== "" && (
        <div className="bg-bg-card border border-border rounded p-3 text-xs text-gold">
          ${line} is outside the strikes listed for {data.expiration} — pick a line inside the chain.
        </div>
      )}

      {data && side && chosen && (
        <>
          <div className="bg-bg-card border border-border rounded p-3">
            <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1.5">
              Do this trade
            </div>
            <div className="font-mono text-sm space-y-0.5">
              <div>
                <span className="text-signal-bear font-bold">SELL to Open</span>{" "}
                <span className="text-text-primary">
                  {position?.contracts ?? 1}x {data.ticker} {data.expiration} ${chosen.shortLeg.strike} {sideWord}
                </span>
                <span className="text-dim text-xs">
                  {" "}· bid {fmtUsd(chosen.shortLeg.bid)}
                  {chosen.shortLeg.delta !== null && ` · ${(Math.abs(chosen.shortLeg.delta) * 100).toFixed(0)}Δ`}
                </span>
              </div>
              <div>
                <span className="text-signal-bull font-bold">BUY to Open</span>{" "}
                <span className="text-text-primary">
                  {position?.contracts ?? 1}x {data.ticker} {data.expiration} ${chosen.longLeg.strike} {sideWord}
                </span>
                <span className="text-dim text-xs"> · ask {fmtUsd(chosen.longLeg.ask)}</span>
              </div>
            </div>
            <p className="text-[11px] text-text-secondary mt-2">
              ${chosen.widthActual} wide
              {chosen.widthShort && <span className="text-gold"> — ${chosen.widthTarget} was not available</span>}
              {" · "}confirm the actual credit at your broker before sending: these quotes are{" "}
              {data.delayed ? "15 minutes delayed" : "live"}.
            </p>
          </div>

          {!chosen.viable && (
            <div className="bg-bg-card border border-signal-bear rounded p-3 text-xs text-signal-bear">
              {chosen.reason === "no_credit" && `This is a ${fmtUsd(Math.abs(chosen.credit ?? 0))} debit at natural prices, not a credit spread.`}
              {chosen.reason === "credit_ge_width" && "These quotes imply risk-free profit — they are stale or crossed. Do not trade this."}
              {chosen.reason === "short_not_bid" && "The leg you would sell has no bid — this strike cannot be sold."}
              {chosen.reason === "long_not_offered" && "The protection leg has no offer."}
              {chosen.reason === "no_two_sided_market" && "There is no two-sided market on these strikes."}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Tile label="Cash in now" value={position ? `$${position.creditReceived.toFixed(0)}` : "n/a"}
              sub={chosen.creditMid !== null && position
                ? `$${(chosen.creditMid * 100 * position.contracts).toFixed(0)} at mid`
                : undefined}
              tone="text-signal-bull" />
            {/* A credit spread costs nothing to open — you are PAID. What it
                consumes is collateral, which the broker releases on close.
                Labelling that "cost" would imply money leaving the account. */}
            <Tile label="Capital held" value={position ? `$${position.capitalHeld.toFixed(0)}` : "n/a"}
              sub="buying power, returned on close" />
            <Tile label="Worst case" value={position ? `−$${position.maxLoss.toFixed(0)}` : "n/a"}
              sub={position && position.contracts > 1 ? `all ${position.contracts} contracts` : "if it goes wrong"}
              tone="text-signal-bear" />
            <Tile label="Breakeven" value={fmtUsd(chosen.breakeven)}
              sub={isPut ? "wins above this" : "wins below this"} />
            <Tile label="Win probability" value={fmtPct(chosen.popShort)}
              sub={chosen.popBreakeven !== null ? `${fmtPct(chosen.popBreakeven)} to breakeven` : "from short delta"} />
            <Tile label="Return on capital"
              value={chosen.maxProfitContract && chosen.maxLossContract && chosen.maxLossContract > 0
                ? `${((chosen.maxProfitContract / chosen.maxLossContract) * 100).toFixed(0)}%` : "n/a"}
              sub="if held to expiry" />
          </div>

          <div className="bg-bg-card border border-border rounded p-3">
            <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1">
              Profit and loss at expiry
            </div>
            <PayoffChart row={chosen} spot={data.spot} contracts={position?.contracts ?? 1} />
            <p className="text-[10px] text-dim mt-1">
              Win probability comes from the short leg's delta — a risk-neutral approximation, not a forecast.
              The spread is still profitable between the strike you sold and the breakeven, so the true
              probability is a little better than the headline. Early assignment and dividends are not modelled.
            </p>
          </div>

          {chosen.closeTargets.length > 0 && position && (
            <div className="bg-bg-card border border-border rounded p-3">
              <div className="text-[11px] uppercase tracking-wide text-text-secondary mb-1">
                Closing the position · {position.contracts} contract{position.contracts === 1 ? "" : "s"}
              </div>
              <p className="text-[11px] text-text-secondary mb-1.5">
                You sold this spread for {fmtUsd(chosen.credit)}. You close it by BUYING it back cheaper —
                the price below is what the spread has to be worth.
              </p>
              <div className="overflow-x-auto">
                <table className="text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-text-secondary border-b border-border">
                      <th className="px-2 py-1 text-left font-semibold">Take</th>
                      <th className="px-2 py-1 text-right font-semibold">Buy it back at</th>
                      <th className="px-2 py-1 text-right font-semibold">You keep</th>
                      <th className="px-2 py-1 text-right font-semibold">On capital</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chosen.closeTargets.map((t) => {
                      const total = t.pnlPerContract * position.contracts;
                      const win = total >= 0;
                      return (
                        <tr key={t.label}
                          className={`border-b border-border/40 last:border-0 ${t.isStop ? "border-t border-t-border" : ""}`}>
                          <td className={`px-2 py-1 whitespace-nowrap ${t.isStop ? "text-signal-bear" : "text-text-secondary"}`}>
                            {t.label}
                            {/* 50% is the conventional exit: the back half of the
                                premium takes the longest to collect and carries
                                the most gamma risk. */}
                            {t.pctOfMax === 0.5 && <span className="text-[9px] text-dim ml-1">· usual exit</span>}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-text-primary">
                            {fmtUsd(t.closePrice)}
                          </td>
                          <td className={`px-2 py-1 text-right tabular-nums font-bold ${win ? "text-signal-bull" : "text-signal-bear"}`}>
                            {win ? "+" : "−"}${Math.abs(total).toFixed(0)}
                          </td>
                          <td className={`px-2 py-1 text-right tabular-nums ${win ? "text-signal-bull" : "text-signal-bear"}`}>
                            {t.returnOnCapital === null ? "n/a"
                              : `${t.returnOnCapital >= 0 ? "" : "−"}${Math.abs(t.returnOnCapital * 100).toFixed(1)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-dim mt-1">
                Closing early also frees the {fmtUsd(position.capitalHeld, 0)} the broker is holding, which is
                the part a return-per-day comparison turns on. Commissions are not modelled.
              </p>
            </div>
          )}

          <div className="bg-bg-card border border-border rounded p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wide text-text-secondary">Safety checklist</div>
              {overall && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  overall === "PASS" ? "bg-signal-bull/15 text-signal-bull"
                    : overall === "FAIL" ? "bg-signal-bear/15 text-signal-bear"
                    : "bg-text-secondary/15 text-text-secondary"}`}>{overall}</span>
              )}
            </div>
            <div className="text-xs">
              <CheckRow label="Days to expiry" check={data.checks.dte} />
              <CheckRow label="Volatility (VIX)" check={data.checks.vix} />
              {liquidity && <CheckRow label="Liquidity" check={liquidity} />}
              <div className="flex items-start gap-2 py-1">
                <span className={`font-bold w-4 text-center shrink-0 ${ack ? "text-signal-bull" : "text-dim"}`}>
                  {ack ? "✓" : "?"}
                </span>
                <label className="text-text-secondary cursor-pointer flex items-start gap-1.5">
                  <input type="checkbox" checked={ack} onChange={toggleAck} className="mt-0.5" />
                  <span>
                    {isPut
                      ? `Would I be happy owning ${data.ticker} at $${chosen.shortLeg.strike}?`
                      : `Would I be happy being short ${data.ticker} at $${chosen.shortLeg.strike}?`}
                  </span>
                </label>
              </div>
            </div>
            {data.vix.degraded && data.vix.warnings.length > 0 && (
              <p className="text-[10px] text-dim mt-1">{data.vix.warnings.join(" · ")}</p>
            )}
          </div>

          {/* The ladder — every strike, so the chosen row has context. */}
          <div className="bg-bg-card border border-border rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-text-secondary border-b border-border">
                  <th className="px-2 py-2 text-left font-semibold">Sell</th>
                  <th className="px-2 py-2 text-left font-semibold">Buy</th>
                  <th className="px-2 py-2 text-right font-semibold">Δ</th>
                  <th className="px-2 py-2 text-right font-semibold">Credit</th>
                  <th className="px-2 py-2 text-right font-semibold">at mid</th>
                  <th className="px-2 py-2 text-right font-semibold">Risk</th>
                  <th className="px-2 py-2 text-right font-semibold">Breakeven</th>
                  <th className="px-2 py-2 text-right font-semibold">Win %</th>
                  <th className="px-2 py-2 text-right font-semibold">OI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const on = chosen.shortLeg.strike === r.shortLeg.strike;
                  return (
                    <tr key={r.shortLeg.strike}
                      onClick={() => setLine(String(r.shortLeg.strike))}
                      className={`border-b border-border/50 cursor-pointer hover:bg-bg-secondary/50 ${
                        on ? "bg-signal-bull/5 border-l-2 border-l-signal-bull" : ""} ${
                        r.viable ? "" : "text-dim"}`}>
                      <td className="px-2 py-1.5 tabular-nums font-bold">${r.shortLeg.strike}</td>
                      <td className="px-2 py-1.5 tabular-nums text-text-secondary">${r.longLeg.strike}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
                        {r.shortLeg.delta === null ? "n/a" : (Math.abs(r.shortLeg.delta) * 100).toFixed(0)}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${r.viable ? "text-signal-bull" : "text-signal-bear line-through"}`}>
                        {r.maxProfitContract === null ? "n/a" : `$${r.maxProfitContract.toFixed(0)}`}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-dim">
                        {r.creditMid === null ? "n/a" : `$${(r.creditMid * 100).toFixed(0)}`}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-signal-bear">
                        {r.maxLossContract === null ? "n/a" : `$${r.maxLossContract.toFixed(0)}`}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtUsd(r.breakeven)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtPct(r.popShort)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
                        {r.shortLeg.openInterest ?? "n/a"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!exp && !loading && !error && (
        <div className="bg-bg-card border border-border rounded p-3 text-xs text-text-secondary space-y-1">
          <p>
            <span className="text-signal-bull font-bold">A Floor Bet</span> sells a put below the price and buys
            a cheaper one further down. You keep the credit if the stock stays above the strike you sold; the
            long leg caps what you can lose.
          </p>
          <p>
            <span className="text-signal-bear font-bold">A Ceiling Bet</span> is the mirror — sell a call above
            the price, buy a cheaper one further up, and keep the credit if the stock stays below.
          </p>
          <p className="text-dim">
            Enter a ticker to begin. Quotes are 15 minutes delayed, which is immaterial for a trade
            28–60 days out — but confirm the real credit at your broker before you send the order.
          </p>
        </div>
      )}
    </div>
  );
}
