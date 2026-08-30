/**
 * Options Strategy Guide — a plain-English credit-spread builder.
 *
 *   FLOOR BET   — bet it stays ABOVE a line   (sell a put)
 *   CEILING BET — bet it stays BELOW a line   (sell a call)
 *
 * Each can be traded two ways, and the difference is the whole risk story:
 *   SPREAD — buy a further-out option as protection. Smaller credit, capped loss.
 *   SINGLE — sell the option alone. Bigger credit, and the cap is gone: a naked
 *            put is bounded only by the stock reaching zero, a naked call is
 *            unbounded outright.
 *
 * ── The view performs NO options arithmetic ───────────────────────────────
 * Every credit, loss, breakeven, probability, payoff vertex and exit rung
 * arrives precomputed from api/src/lib/spreadMath.ts, covered by
 * api/tools/spread-math-test.mjs. The only calculation here is multiplying
 * per-contract figures by the contract count — so there is exactly one
 * implementation of the money math and the chart cannot disagree with the
 * numbers beside it.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 * Two columns on wide screens: the questions stay pinned on the left while the
 * answer occupies the right, so changing a strike never pushes the result off
 * screen. Sized to fit a normal viewport without scrolling.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { getOptionsExpiries, getOptionsSpread } from "../services/api.js";
import type {
  OptionsExpiriesResponse, OptionsSpreadResponse, SpreadRow, SpreadSide, SpreadCheck,
} from "../types.js";

const WIDTH_LABEL: Record<number, string> = { 5: "Basic", 10: "Full", 20: "Max" };
const ACK_KEY = "options_guide_ack";

const fmtUsd = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `$${v.toFixed(dp)}`;
const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(0)}%`;
const fmt0 = (v: number) => `$${Math.abs(v).toFixed(0)}`;

function fmtAsOf(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

/** Glyph + tone per checklist state. No icon library — the portal uses glyphs. */
function checkGlyph(state: string): { g: string; cls: string } {
  if (state === "pass") return { g: "✓", cls: "text-signal-bull" };
  if (state === "fail") return { g: "✗", cls: "text-signal-bear" };
  if (state === "warn") return { g: "!", cls: "text-gold" };
  return { g: "?", cls: "text-dim" };
}

function Tile({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: string;
}) {
  return (
    <div className="bg-bg-card border border-border rounded px-2.5 py-1.5 flex-1 min-w-[96px]">
      <div className="text-[9px] uppercase tracking-wide text-text-secondary whitespace-nowrap">{label}</div>
      <div className={`text-lg font-bold leading-tight tabular-nums ${tone || "text-text-primary"}`}>{value}</div>
      {sub && <div className="text-[9px] text-dim leading-tight">{sub}</div>}
    </div>
  );
}

/**
 * The payoff diagram.
 *
 * Modelled on Timeline in SpyConvictionPage.tsx — same clamping scale closures,
 * colour via Tailwind classes on the elements, <title> children, role="img".
 *
 * Zones are shaded BY PRICE, split at the breakeven, rather than under the
 * curve: the plain-English claim is "you win if it stays above your line", and
 * a price-axis band says exactly that.
 *
 * On a SINGLE leg the outer end of the line keeps sloping instead of flattening.
 * That missing floor is the entire visual difference from a spread, and the one
 * thing the operator most needs to see before selling one.
 */
function PayoffChart({ row, spot, contracts }: { row: SpreadRow; spot: number; contracts: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = 168, L = 56, R = 14, TOP = 16, BOT = 112;

  // Scaling per-contract vertices by an integer is the only arithmetic here.
  const n = Math.max(1, Math.floor(contracts) || 1);
  const pts = row.payoff.map((p) => ({ price: p.price, pl: p.pl * n }));
  if (!pts.length || row.credit === null || row.breakeven === null) return null;

  const rawLo = Math.min(...pts.map((p) => p.price), spot);
  const rawHi = Math.max(...pts.map((p) => p.price), spot);
  const margin = (rawHi - rawLo) * 0.04 || 1;
  const lo = rawLo - margin, hi = rawHi + margin;
  const span = hi - lo || 1;
  const x = (p: number) => L + ((Math.min(Math.max(p, lo), hi) - lo) / span) * (W - L - R);

  const profit = (row.maxProfitContract ?? 0) * n;
  const worst = Math.min(...pts.map((p) => p.pl));
  const yMax = profit * 1.7 || 1;
  const yMin = worst * 1.12 || -1;
  const y = (v: number) =>
    BOT - ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (BOT - TOP);

  /** P/L at any price, interpolated along the same vertices the line is drawn from. */
  const plAt = (price: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (price >= a.price && price <= b.price) {
        if (b.price === a.price) return b.pl;
        return a.pl + ((price - a.price) / (b.price - a.price)) * (b.pl - a.pl);
      }
    }
    return price < pts[0].price ? pts[0].pl : pts[pts.length - 1].pl;
  };

  const be = row.breakeven;
  const winRight = row.side === "floor";
  const ticks = Array.from({ length: 6 }, (_, i) => lo + (span * i) / 5);
  const markers = [
    { p: spot, cls: "text-text-primary", dash: "3 3", label: `now $${spot.toFixed(2)}` },
    { p: row.shortLeg.strike, cls: "text-accent", dash: undefined, label: `sell $${row.shortLeg.strike}` },
    ...(row.longLeg ? [{ p: row.longLeg.strike, cls: "text-dim", dash: undefined, label: `buy $${row.longLeg.strike}` }] : []),
    { p: be, cls: "text-gold", dash: "2 2", label: `breakeven $${be.toFixed(2)}` },
  ].sort((a, b) => a.p - b.p);

  return (
    <div className="overflow-x-auto">
      <div className="text-[10px] text-text-secondary h-3.5">
        {hover !== null ? (
          <>
            at <span className="text-text-primary tabular-nums">${hover.toFixed(2)}</span>{" → "}
            <span className={`tabular-nums font-bold ${plAt(hover) >= 0 ? "text-signal-bull" : "text-signal-bear"}`}>
              {plAt(hover) >= 0 ? "+" : "−"}{fmt0(plAt(hover))}
            </span>
          </>
        ) : <span className="text-dim">hover to read profit or loss at any price</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img"
        aria-label={`Profit and loss at expiry for the ${row.side} ${row.structure}`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          if (px < L || px > W - R) { setHover(null); return; }
          setHover(lo + ((px - L) / (W - L - R)) * span);
        }}
        onMouseLeave={() => setHover(null)}>
        <rect x={x(lo)} y={TOP} width={Math.max(0, x(be) - x(lo))} height={BOT - TOP}
          className={winRight ? "fill-signal-bear" : "fill-signal-bull"} opacity={0.10} />
        <rect x={x(be)} y={TOP} width={Math.max(0, x(hi) - x(be))} height={BOT - TOP}
          className={winRight ? "fill-signal-bull" : "fill-signal-bear"} opacity={0.10} />

        {[profit, 0, worst].map((v, i) => (
          <g key={i}>
            <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="currentColor"
              className={v === 0 ? "text-text-secondary" : "text-border"}
              strokeWidth={v === 0 ? 1 : 0.5} strokeDasharray={v === 0 ? undefined : "2 3"} />
            <text x={L - 5} y={y(v) + 3} textAnchor="end" fontSize={9}
              className={`fill-current ${v > 0 ? "text-signal-bull" : v < 0 ? "text-signal-bear" : "text-text-secondary"}`}>
              {v > 0 ? `+${fmt0(v)}` : v < 0 ? `−${fmt0(v)}` : "$0"}
            </text>
          </g>
        ))}
        {/* A single leg has no floor — say so where the axis would imply one. */}
        {row.structure === "single" && (
          <text x={L + 4} y={BOT - 3} fontSize={8.5} className="fill-current text-signal-bear">
            {row.unlimitedRisk ? "no ceiling on this loss" : "keeps falling to $0"}
          </text>
        )}

        {ticks.map((t, i) => (
          <text key={i} x={x(t)} y={BOT + 13} textAnchor="middle" fontSize={9}
            className="fill-current text-text-secondary">${t.toFixed(0)}</text>
        ))}

        <polyline fill="none" stroke="currentColor" className="text-text-primary" strokeWidth={2}
          points={pts.map((p) => `${x(p.price)},${y(p.pl)}`).join(" ")} />

        {markers.map((m, i) => (
          <g key={m.label}>
            <line x1={x(m.p)} y1={TOP - 4} x2={x(m.p)} y2={BOT + 2} stroke="currentColor"
              className={m.cls} strokeWidth={1} strokeDasharray={m.dash} />
            <text x={x(m.p)} y={i % 2 === 0 ? H - 17 : H - 5} fontSize={8.5}
              textAnchor={x(m.p) < L + 40 ? "start" : x(m.p) > W - R - 40 ? "end" : "middle"}
              className={`fill-current ${m.cls}`}>{m.label}</text>
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
    <div className="flex items-start gap-1.5 py-0.5">
      <span className={`font-bold ${cls} w-3 text-center shrink-0`}>{g}</span>
      <span className="text-text-secondary w-24 shrink-0">{label}</span>
      <span className={cls}>{check.detail}</span>
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

  const [side, setSide] = useState<SpreadSide | null>(null);
  const [structure, setStructure] = useState<"spread" | "single">("spread");
  const [line, setLine] = useState("");
  const [widthTarget, setWidthTarget] = useState(5);
  const [contracts, setContracts] = useState(1);
  const [riskBudget, setRiskBudget] = useState("");
  const [ack, setAck] = useState(false);
  const [useAnyway, setUseAnyway] = useState(false);

  const loadTicker = useCallback(async (sym: string) => {
    const t = sym.trim().toUpperCase();
    if (!t) return;
    setLoading(true); setError(null);
    setExp(null); setData(null); setSide(null); setLine(""); setUseAnyway(false);
    try {
      const e = await getOptionsExpiries(t);
      setExp(e); setTicker(t);
      setExpiration(e.recommended || e.expirations[0]?.date || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load");
    } finally { setLoading(false); }
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

  useEffect(() => {
    if (!data || !side) return;
    const rec = data.recommended[side];
    if (rec) setLine(String(rec.strike));
  }, [data, side]);

  const rows: SpreadRow[] = useMemo(() => {
    if (!data || !side) return [];
    const key = structure === "single" ? "single" : `w${widthTarget}`;
    return data.ladder[side]?.[key] ?? [];
  }, [data, side, structure, widthTarget]);

  /** Resolve the typed line to a row. A lookup, not a recalculation. */
  const chosen: SpreadRow | null = useMemo(() => {
    if (!rows.length) return null;
    const v = Number(line);
    if (!Number.isFinite(v)) return null;
    const strikes = rows.map((r) => r.shortLeg.strike).sort((a, b) => a - b);
    const k = side === "floor"
      ? [...strikes].reverse().find((s) => s <= v)
      : strikes.find((s) => s >= v);
    return k === undefined ? null : rows.find((r) => r.shortLeg.strike === k) ?? null;
  }, [rows, line, side]);

  /**
   * The sized position. `capitalPerContract` is the collateral the broker holds
   * — on a spread that equals max loss, on a cash-secured put it is the strike,
   * on a naked call it is a margin estimate. Max loss is a SEPARATE number, and
   * on a naked call there is none at all.
   */
  const position = useMemo(() => {
    if (!chosen || chosen.maxProfitContract === null) return null;
    const n = Math.max(1, Math.floor(contracts) || 1);
    return {
      contracts: n,
      creditReceived: chosen.maxProfitContract * n,
      capitalHeld: chosen.capitalPerContract === null ? null : chosen.capitalPerContract * n,
      maxLoss: chosen.maxLossContract === null ? null : chosen.maxLossContract * n,
    };
  }, [chosen, contracts]);

  /** Risk budget → contracts. FLOORS, so it can never size above the budget. */
  const suggested = useMemo(() => {
    const b = Number(riskBudget);
    const per = chosen?.maxLossContract ?? chosen?.capitalPerContract ?? null;
    if (!per || per <= 0 || !Number.isFinite(b) || b <= 0) return null;
    return Math.floor(b / per);
  }, [chosen, riskBudget]);

  const ackKey = chosen && data
    ? `${data.ticker}|${data.expiration}|${chosen.side}|${chosen.structure}|${chosen.shortLeg.strike}` : "";

  useEffect(() => {
    if (!ackKey) { setAck(false); return; }
    try {
      const raw = localStorage.getItem(ACK_KEY);
      setAck(Boolean((raw ? JSON.parse(raw) : {})[ackKey]));
    } catch { setAck(false); }
  }, [ackKey]);

  const toggleAck = () => {
    const next = !ack; setAck(next);
    if (!ackKey) return;
    try {
      const raw = localStorage.getItem(ACK_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (next) map[ackKey] = true; else delete map[ackKey];
      localStorage.setItem(ACK_KEY, JSON.stringify(map));
    } catch { /* private window: the box simply does not persist */ }
  };

  const liquidity: SpreadCheck | null = useMemo(() => {
    if (!chosen || !data) return null;
    const s = chosen.shortLeg;
    const ok = (x: { bid: number | null; ask: number | null }) =>
      x.bid !== null && x.ask !== null && x.bid > 0 && x.ask > 0;
    if (!ok(s)) return { state: "fail", detail: "the leg you are selling has no bid" };
    if (chosen.longLeg && !ok(chosen.longLeg)) return { state: "fail", detail: "the protection leg has no offer" };
    const ois = [s.openInterest, chosen.longLeg?.openInterest ?? null].filter((v): v is number => v !== null);
    if (!ois.length) return { state: "unknown", detail: "open interest not reported" };
    const thin = Math.min(...ois);
    if (thin < data.rules.min_open_interest) {
      return { state: "warn", detail: `open interest ${thin} — under ${data.rules.min_open_interest}` };
    }
    return { state: "pass", detail: `open interest ${thin}` };
  }, [chosen, data]);

  const overall = useMemo(() => {
    if (!data || !chosen || !liquidity) return null;
    const st = [data.checks.dte.state, data.checks.vix.state, liquidity.state];
    // A single leg always carries a failing protection row, so it can never
    // read PASS. That is the intended answer, not a bug.
    if (chosen.structure === "single") return "FAIL";
    if (st.includes("fail")) return "FAIL";
    if (!ack) return "INCOMPLETE";
    if (st.includes("warn") || st.includes("unknown")) return "REVIEW";
    return "PASS";
  }, [data, chosen, liquidity, ack]);

  const isPut = side === "floor";
  const sideWord = isPut ? "Put" : "Call";
  const notConfigured = error?.includes("FINVIZ_API_KEY");
  const parseFailed = error?.toLowerCase().includes("payload") || error?.toLowerCase().includes("parse");

  const btn = (on: boolean) =>
    `px-2 py-0.5 rounded text-[11px] ${on ? "bg-text-primary text-bg-primary"
      : "border border-border text-text-secondary hover:text-text-primary"}`;

  return (
    <div className="space-y-2">
      {/* Compact header bar: identity, expiry and freshness all on one line. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="section-header text-base">Options Strategy Guide</h2>
        <form onSubmit={(e) => { e.preventDefault(); void loadTicker(query); }}
          className="flex items-center gap-1.5">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="AAPL"
            className="bg-bg-secondary border border-border rounded px-2 py-0.5 text-text-primary uppercase w-24" />
          <button type="submit" className={btn(false)}>Load</button>
        </form>
        {exp && (
          <span className="text-xs">
            <span className="text-text-primary font-bold">{exp.ticker}</span>{" "}
            <span className="tabular-nums text-text-secondary">${exp.spot.toFixed(2)}</span>
          </span>
        )}
        {exp && exp.expirations.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {exp.expirations.map((e) => (
              <button key={e.date} type="button" onClick={() => setExpiration(e.date)}
                title={e.monthly ? "monthly — deeper liquidity" : "weekly"}
                className={`${btn(expiration === e.date)} tabular-nums`}>
                {e.date.slice(5)} <span className="text-[9px]">{e.dte}d</span>{e.monthly && <span className="text-[9px]">M</span>}
              </button>
            ))}
          </div>
        )}
        {loading && <span className="text-xs text-text-secondary">Loading…</span>}
        {data && (
          <span className="text-[10px] text-dim ml-auto">
            {data.feed} {data.delayed ? "· 15-min delayed" : "· live"}
            {data.as_of ? ` · ${fmtAsOf(data.as_of)} PT` : ""}
          </span>
        )}
      </div>

      {notConfigured && (
        <div className="bg-bg-card border border-gold rounded p-2 text-xs">
          <span className="font-bold text-gold">Option chain not configured. </span>
          <span className="text-text-secondary">
            <code className="text-text-primary">FINVIZ_API_KEY</code> is unset; the feed is chosen by{" "}
            <code className="text-text-primary">OPTIONS_FEED</code>.
          </span>
        </div>
      )}
      {parseFailed && (
        <div className="bg-bg-card border border-signal-bear rounded p-2 text-xs">
          <span className="font-bold text-signal-bear">The chain could not be read. </span>
          <span className="text-text-secondary">
            The upstream page changed — <code>api/src/lib/finvizOptions.ts</code> needs updating.
            Nothing is shown rather than a partial chain.
          </span>
        </div>
      )}
      {error && !notConfigured && !parseFailed && (
        <div className="bg-bg-card border border-border rounded p-2 text-xs text-signal-bear">{error}</div>
      )}

      {exp && exp.expirations.length === 0 && (
        <div className="bg-bg-card border border-border rounded p-2 text-xs">
          <span className="text-gold">Nothing expires {exp.dte_window[0]}–{exp.dte_window[1]} days out. </span>
          <label className="text-text-secondary cursor-pointer">
            <input type="checkbox" checked={useAnyway} onChange={() => setUseAnyway(!useAnyway)} className="mr-1" />
            use one anyway — the checklist will flag it
          </label>
          {useAnyway && (
            <div className="flex flex-wrap gap-1 mt-1">
              {exp.outside_window.slice(0, 12).map((e) => (
                <button key={e.date} type="button" onClick={() => setExpiration(e.date)}
                  className={`${btn(expiration === e.date)} tabular-nums`}>{e.date} <span className="text-[9px]">{e.dte}d</span></button>
              ))}
            </div>
          )}
        </div>
      )}

      {!exp && !loading && !error && (
        <div className="bg-bg-card border border-border rounded p-3 text-xs text-text-secondary space-y-1">
          <p><span className="text-signal-bull font-bold">A Floor Bet</span> sells a put below the price. You keep the
            credit if the stock stays above the strike you sold.</p>
          <p><span className="text-signal-bear font-bold">A Ceiling Bet</span> is the mirror — sell a call above the price.</p>
          <p>Each can be a <span className="text-text-primary">spread</span> (buy protection, capped loss) or a{" "}
            <span className="text-text-primary">single leg</span> (bigger credit, no cap). Enter a ticker to begin.</p>
        </div>
      )}

      {/* ── Two columns: questions pinned left, the answer fills the right ── */}
      {data && (
        <div className="flex flex-col lg:flex-row gap-2 items-start">
          {/* LEFT: the questions */}
          <div className="w-full lg:w-[290px] shrink-0 space-y-2">
            <div className="bg-bg-card border border-border rounded p-2 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-text-secondary">
                1 · Where is {data.ticker} going?
              </div>
              <div className="grid grid-cols-2 gap-1">
                <button type="button" onClick={() => setSide("floor")}
                  className={`px-2 py-1.5 rounded border text-left ${
                    side === "floor" ? "border-signal-bull ring-1 ring-signal-bull" : "border-border hover:bg-bg-secondary"}`}>
                  <div className="font-bold text-signal-bull text-xs">Stays ABOVE</div>
                  <div className="text-[9px] text-text-secondary">Floor Bet</div>
                </button>
                <button type="button" onClick={() => setSide("ceiling")}
                  className={`px-2 py-1.5 rounded border text-left ${
                    side === "ceiling" ? "border-signal-bear ring-1 ring-signal-bear" : "border-border hover:bg-bg-secondary"}`}>
                  <div className="font-bold text-signal-bear text-xs">Stays BELOW</div>
                  <div className="text-[9px] text-text-secondary">Ceiling Bet</div>
                </button>
              </div>
            </div>

            {side && (
              <div className="bg-bg-card border border-border rounded p-2 space-y-1.5">
                <div className="text-[10px] uppercase tracking-wide text-text-secondary">2 · How much protection?</div>
                <div className="flex flex-wrap gap-1">
                  {data.rules.widths.map((w) => (
                    <button key={w} type="button"
                      onClick={() => { setStructure("spread"); setWidthTarget(w); }}
                      className={btn(structure === "spread" && widthTarget === w)}>
                      {WIDTH_LABEL[w] ?? `$${w}`} <span className="text-[9px]">${w}</span>
                    </button>
                  ))}
                  {/* The no-protection choice, styled as a warning rather than as
                      just another width — it is a materially different trade. */}
                  <button type="button" onClick={() => setStructure("single")}
                    className={`px-2 py-0.5 rounded text-[11px] ${
                      structure === "single" ? "bg-signal-bear text-bg-primary"
                        : "border border-signal-bear/50 text-signal-bear hover:bg-signal-bear/10"}`}>
                    None · 1 leg
                  </button>
                </div>
                {structure === "single" && (
                  <p className="text-[10px] text-signal-bear leading-snug">
                    {isPut
                      ? "Naked put — you keep the whole premium, but the loss runs all the way to $0 and you can be assigned the shares."
                      : "Naked call — you keep the whole premium, and the loss is UNLIMITED. There is no ceiling on a share price."}
                  </p>
                )}
              </div>
            )}

            {side && (
              <div className="bg-bg-card border border-border rounded p-2 space-y-1.5">
                <div className="text-[10px] uppercase tracking-wide text-text-secondary">3 · Your line, and size</div>
                <div className="flex items-center gap-1.5">
                  <input value={line} onChange={(e) => setLine(e.target.value)} inputMode="decimal"
                    className="bg-bg-secondary border border-border rounded px-2 py-0.5 text-text-primary w-20 tabular-nums" />
                  {data.recommended[side] && (
                    <span className="text-[10px] text-text-secondary">
                      math likes{" "}
                      <button type="button" onClick={() => setLine(String(data.recommended[side]!.strike))}
                        className="text-accent hover:underline tabular-nums">${data.recommended[side]!.strike}</button>{" "}
                      <span className="text-dim">({(data.recommended[side]!.delta * 100).toFixed(0)}Δ)</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-text-secondary w-14">Contracts</span>
                  <button type="button" onClick={() => setContracts((c) => Math.max(1, c - 1))} className={btn(false)}>−</button>
                  <input value={contracts} inputMode="numeric"
                    onChange={(e) => { const v = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10); setContracts(Number.isFinite(v) && v > 0 ? v : 1); }}
                    className="bg-bg-secondary border border-border rounded px-1 py-0.5 text-text-primary w-12 text-center tabular-nums" />
                  <button type="button" onClick={() => setContracts((c) => c + 1)} className={btn(false)}>+</button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-text-secondary w-14">Risk max</span>
                  <input value={riskBudget} onChange={(e) => setRiskBudget(e.target.value)} placeholder="$500" inputMode="decimal"
                    className="bg-bg-secondary border border-border rounded px-2 py-0.5 text-text-primary w-16 tabular-nums" />
                  {suggested !== null && (suggested > 0 ? (
                    <button type="button" onClick={() => setContracts(suggested)} className="text-[10px] text-accent hover:underline">
                      → {suggested}
                    </button>
                  ) : <span className="text-[10px] text-gold">1 is too many</span>)}
                </div>
              </div>
            )}

            {/* The ladder lives here so it never pushes the answer off screen. */}
            {side && rows.length > 0 && (
              <div className="bg-bg-card border border-border rounded overflow-hidden">
                <div className="text-[10px] uppercase tracking-wide text-text-secondary px-2 pt-1.5">Every strike</div>
                <div className="overflow-y-auto max-h-[180px]">
                  <table className="w-full text-[11px]">
                    <thead className="text-[9px] uppercase text-text-secondary sticky top-0 bg-bg-card">
                      <tr className="border-b border-border">
                        <th className="px-1.5 py-1 text-left">Sell</th>
                        <th className="px-1 py-1 text-right">Δ</th>
                        <th className="px-1 py-1 text-right">Credit</th>
                        <th className="px-1.5 py-1 text-right">Win</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.shortLeg.strike} onClick={() => setLine(String(r.shortLeg.strike))}
                          className={`border-b border-border/40 cursor-pointer hover:bg-bg-secondary/50 ${
                            chosen?.shortLeg.strike === r.shortLeg.strike ? "bg-signal-bull/10" : ""} ${r.viable ? "" : "text-dim"}`}>
                          <td className="px-1.5 py-0.5 tabular-nums font-bold">${r.shortLeg.strike}</td>
                          <td className="px-1 py-0.5 text-right tabular-nums text-text-secondary">
                            {r.shortLeg.delta === null ? "—" : (Math.abs(r.shortLeg.delta) * 100).toFixed(0)}
                          </td>
                          <td className="px-1 py-0.5 text-right tabular-nums text-signal-bull">
                            {r.maxProfitContract === null ? "—" : fmt0(r.maxProfitContract)}
                          </td>
                          <td className="px-1.5 py-0.5 text-right tabular-nums">{fmtPct(r.popShort)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: the answer */}
          <div className="flex-1 min-w-0 space-y-2">
            {!side && (
              <div className="bg-bg-card border border-border rounded p-3 text-xs text-text-secondary">
                Pick a direction to see the trade.
              </div>
            )}

            {side && !chosen && line !== "" && (
              <div className="bg-bg-card border border-border rounded p-2 text-xs text-gold">
                ${line} is outside the strikes listed for {data.expiration}.
              </div>
            )}

            {side && chosen && position && (
              <>
                <div className="bg-bg-card border border-border rounded p-2">
                  <div className="font-mono text-[13px] leading-snug">
                    <div>
                      <span className="text-signal-bear font-bold">SELL to Open</span>{" "}
                      <span className="text-text-primary">
                        {position.contracts}x {data.ticker} {data.expiration} ${chosen.shortLeg.strike} {sideWord}
                      </span>
                      <span className="text-dim text-[11px]"> · bid {fmtUsd(chosen.shortLeg.bid)}
                        {chosen.shortLeg.delta !== null && ` · ${(Math.abs(chosen.shortLeg.delta) * 100).toFixed(0)}Δ`}</span>
                    </div>
                    {chosen.longLeg ? (
                      <div>
                        <span className="text-signal-bull font-bold">BUY to Open</span>{" "}
                        <span className="text-text-primary">
                          {position.contracts}x {data.ticker} {data.expiration} ${chosen.longLeg.strike} {sideWord}
                        </span>
                        <span className="text-dim text-[11px]"> · ask {fmtUsd(chosen.longLeg.ask)}</span>
                      </div>
                    ) : (
                      <div className="text-[11px] text-signal-bear">no second leg — nothing is protecting this</div>
                    )}
                  </div>
                  <p className="text-[10px] text-text-secondary mt-1">
                    {chosen.longLeg ? `$${chosen.widthActual} wide · ` : ""}
                    confirm the actual credit at your broker — these quotes are{" "}
                    {data.delayed ? "15 minutes delayed" : "live"}.
                  </p>
                </div>

                {!chosen.viable && (
                  <div className="bg-bg-card border border-signal-bear rounded p-2 text-xs text-signal-bear">
                    {chosen.reason === "no_credit" && `A ${fmtUsd(Math.abs(chosen.credit ?? 0))} debit at natural prices, not a credit.`}
                    {chosen.reason === "credit_ge_width" && "Quotes imply risk-free profit — stale or crossed. Do not trade this."}
                    {chosen.reason === "short_not_bid" && "The leg you would sell has no bid."}
                    {chosen.reason === "long_not_offered" && "The protection leg has no offer."}
                    {chosen.reason === "no_two_sided_market" && "No two-sided market on these strikes."}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5">
                  <Tile label="Cash in now" value={fmt0(position.creditReceived)}
                    sub={chosen.creditMid !== null ? `${fmt0(chosen.creditMid * 100 * position.contracts)} at mid` : undefined}
                    tone="text-signal-bull" />
                  <Tile label="Capital held"
                    value={position.capitalHeld === null ? "n/a" : fmt0(position.capitalHeld)}
                    sub={chosen.capitalBasis === "spread" ? "returned on close"
                      : chosen.capitalBasis === "cash-secured" ? "cash-secured" : "margin est."} />
                  {/* Unlimited is not a number and must never be rendered as one. */}
                  <Tile label="Worst case"
                    value={chosen.unlimitedRisk ? "UNLIMITED" : position.maxLoss === null ? "n/a" : `−${fmt0(position.maxLoss)}`}
                    sub={chosen.unlimitedRisk ? "no ceiling on the loss"
                      : position.contracts > 1 ? `all ${position.contracts}` : "if it goes wrong"}
                    tone="text-signal-bear" />
                  <Tile label="Breakeven" value={fmtUsd(chosen.breakeven)}
                    sub={isPut ? "wins above" : "wins below"} />
                  <Tile label="Win prob." value={fmtPct(chosen.popShort)}
                    sub={chosen.popBreakeven !== null ? `${fmtPct(chosen.popBreakeven)} to BE` : "from delta"} />
                  <Tile label="On capital"
                    value={chosen.maxProfitContract && chosen.capitalPerContract && chosen.capitalPerContract > 0
                      ? `${((chosen.maxProfitContract / chosen.capitalPerContract) * 100).toFixed(1)}%` : "n/a"}
                    sub="held to expiry" />
                </div>

                <div className="bg-bg-card border border-border rounded p-2">
                  <PayoffChart row={chosen} spot={data.spot} contracts={position.contracts} />
                </div>

                <div className="flex flex-col xl:flex-row gap-2 items-start">
                  {chosen.closeTargets.length > 0 && (
                    <div className="bg-bg-card border border-border rounded p-2 flex-1 min-w-0 w-full">
                      <div className="text-[10px] uppercase tracking-wide text-text-secondary mb-0.5">
                        Closing · {position.contracts} contract{position.contracts === 1 ? "" : "s"}
                      </div>
                      <table className="w-full text-[11px]">
                        <thead className="text-[9px] uppercase text-text-secondary">
                          <tr className="border-b border-border">
                            <th className="px-1 py-0.5 text-left">Take</th>
                            <th className="px-1 py-0.5 text-right">Buy back at</th>
                            <th className="px-1 py-0.5 text-right">You keep</th>
                            <th className="px-1 py-0.5 text-right">On cap.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chosen.closeTargets.map((t) => {
                            const total = t.pnlPerContract * position.contracts;
                            const win = total >= 0;
                            return (
                              <tr key={t.label} className={`border-b border-border/30 last:border-0 ${t.isStop ? "border-t border-t-border" : ""}`}>
                                <td className={`px-1 py-0.5 whitespace-nowrap ${t.isStop ? "text-signal-bear" : "text-text-secondary"}`}>
                                  {t.label}{t.pctOfMax === 0.5 && <span className="text-[9px] text-dim ml-1">· usual</span>}
                                </td>
                                <td className="px-1 py-0.5 text-right tabular-nums">{fmtUsd(t.closePrice)}</td>
                                <td className={`px-1 py-0.5 text-right tabular-nums font-bold ${win ? "text-signal-bull" : "text-signal-bear"}`}>
                                  {win ? "+" : "−"}{fmt0(total)}
                                </td>
                                <td className={`px-1 py-0.5 text-right tabular-nums ${win ? "text-signal-bull" : "text-signal-bear"}`}>
                                  {t.returnOnCapital === null ? "—"
                                    : `${t.returnOnCapital >= 0 ? "" : "−"}${Math.abs(t.returnOnCapital * 100).toFixed(1)}%`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="bg-bg-card border border-border rounded p-2 flex-1 min-w-0 w-full">
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="text-[10px] uppercase tracking-wide text-text-secondary">Safety checklist</div>
                      {overall && (
                        <span className={`px-1.5 rounded text-[9px] font-bold ${
                          overall === "PASS" ? "bg-signal-bull/15 text-signal-bull"
                            : overall === "FAIL" ? "bg-signal-bear/15 text-signal-bear"
                            : "bg-text-secondary/15 text-text-secondary"}`}>{overall}</span>
                      )}
                    </div>
                    <div className="text-[11px]">
                      <CheckRow label="Days to expiry" check={data.checks.dte} />
                      <CheckRow label="Volatility" check={data.checks.vix} />
                      {liquidity && <CheckRow label="Liquidity" check={liquidity} />}
                      {chosen.structure === "single" && (
                        <CheckRow label="Protection"
                          check={{ state: "fail", detail: chosen.unlimitedRisk ? "none — loss is unlimited" : "none — loss runs to $0" }} />
                      )}
                      <div className="flex items-start gap-1.5 py-0.5">
                        <span className={`font-bold w-3 text-center shrink-0 ${ack ? "text-signal-bull" : "text-dim"}`}>{ack ? "✓" : "?"}</span>
                        <label className="text-text-secondary cursor-pointer flex items-start gap-1">
                          <input type="checkbox" checked={ack} onChange={toggleAck} className="mt-0.5" />
                          <span>{isPut ? `Happy owning ${data.ticker} at $${chosen.shortLeg.strike}?`
                            : `Happy being short ${data.ticker} at $${chosen.shortLeg.strike}?`}</span>
                        </label>
                      </div>
                    </div>
                    <p className="text-[9px] text-dim mt-0.5 leading-snug">
                      Win probability is the short leg's delta — an approximation, not a forecast.
                      Early assignment, dividends and commissions are not modelled.
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
