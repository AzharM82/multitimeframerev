import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SpyConvictionResponse, ConvictionEvent, ConvictionState, SpyResearchReport,
  SpyShadowResponse, ShadowTrade,
} from "../types.js";
import { getSpyConviction, forceSpyFlat, getSpyShadow, evaluateSpyShadow } from "../services/api.js";
import { SpyHowItWorks } from "./spy/SpyHowItWorks.js";
import { fmtTimePT, PT_LABEL } from "../utils/time.js";

/**
 * SPY Conviction — the window into the score system.
 *
 * WHY THIS EXISTS: the system is alerts-only, and by design most events produce
 * NO alert. Every 10-minute bar sends something; HOLD and STAND_ASIDE are the
 * quiet majority and stay silent on purpose. That is correct, but from the
 * operator's phone a healthy quiet system and a dead one look identical — the
 * lesson the streak tab was built on, and it carries over unchanged.
 *
 * So the page answers ONE question first — "is it alive, and what did it
 * decide?" — and gives the silent bars and the REJECTED hits the same
 * prominence as the alerts. A wrong secret must never look like a flat tape.
 */

/**
 * Times DISPLAY in Pacific via utils/time — the portal-wide rule. Market LOGIC
 * (the 9:30–16:00 session, the trading-day partition key) stays Eastern, which
 * is why ET survives below for positioning and for `tradingDay`.
 */
const ET = "America/New_York";

/** The ET trading date is the STORAGE key — every row is filed under it. */
const tradingDay = () => new Date().toLocaleDateString("en-CA", { timeZone: ET });

/** Minutes since ET midnight — the x-axis unit. Positioning only, never shown. */
function etMinutes(iso: string): number {
  const t = new Date(iso).toLocaleTimeString("en-GB", { timeZone: ET, hour12: false });
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

/**
 * Where a bar belongs on the x-axis.
 *
 * The BAR's own timestamp, not the arrival time. They agree to within seconds
 * on a healthy feed, but when they disagree — a retry, a delayed webhook, a
 * replayed session — the bar time is the one that says when the market actually
 * did the thing. `barHhmm` is exchange time (ET), which is what the axis is in.
 */
function barMinutes(e: ConvictionEvent): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(e.barHhmm ?? "");
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return etMinutes(e.receivedAt);
}

/**
 * An ET session minute rendered as a Pacific clock label — 9:30 ET reads 6:30.
 * US Eastern and Pacific change DST on the same dates, so the gap is a constant
 * three hours year-round and a fixed shift is exact, not an approximation.
 */
const ptTick = (etMin: number) => {
  const m = etMin - 180;
  return `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * The bar's own clock, in Pacific — what the table shows.
 *
 * Deliberately NOT the arrival time. On a healthy feed they agree to within
 * seconds, but the arrival time of a backfill or a replay is "now" for every
 * row, which reads as twenty alerts in the same minute and disagrees with the
 * chart, which is drawn on bar time. The bar time is when the market did the
 * thing, and that is the column an operator is actually reading.
 */
function barLabelPT(e: ConvictionEvent): string {
  const min = barMinutes(e) - 180;
  const h12 = ((Math.floor(min / 60) + 11) % 12) + 1;
  const ampm = Math.floor(min / 60) % 24 < 12 ? "AM" : "PM";
  return `${h12}:${String(((min % 60) + 60) % 60).padStart(2, "0")} ${ampm}`;
}

const ago = (iso: string | null) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return null;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h${String(mins % 60).padStart(2, "0")}m ago` : `${Math.floor(h / 24)}d ago`;
};

/** Bullish states green, bearish red, flat neutral — one rule, used everywhere. */
function toneOf(x: { side?: string; state?: string; score?: number }): string {
  const s = x.side ?? x.state ?? "";
  if (s.includes("CALL")) return "text-signal-bull";
  if (s.includes("PUT")) return "text-signal-bear";
  if (typeof x.score === "number" && x.score !== 0) {
    return x.score > 0 ? "text-signal-bull" : "text-signal-bear";
  }
  return "text-text-secondary";
}

const STATE_LABEL: Record<ConvictionState, string> = {
  FLAT: "FLAT",
  ARMED_CALL: "ARMED · CALLS",
  ARMED_PUT: "ARMED · PUTS",
  LONG_CALL: "LONG CALLS",
  LONG_PUT: "LONG PUTS",
};

/** Signals that move real money get a pin; the rest are score samples only. */
const PINNED = new Set(["ARM_CALL", "ARM_PUT", "ARM_CANCEL", "BUY_CALL", "BUY_PUT",
  "REDUCE_CALL", "REDUCE_PUT", "SELL_CALL", "SELL_PUT"]);

// ─── The timeline ────────────────────────────────────────────────────────────

/**
 * Conviction score across the session, zero-centred, with the decisions pinned
 * on it.
 *
 * The score line is the whole story the streak bands used to tell, and it tells
 * it better: you can see conviction building toward an ARM and draining before
 * a SELL, instead of a binary colour that flips with no warning. A gap in the
 * line is a gap in the feed — that must stay visible, so segments are only
 * joined between consecutive bars.
 */
function Timeline({ events, isToday }: { events: ConvictionEvent[]; isToday: boolean }) {
  // L leaves room for the 9:30 tick label, which is centred on the axis origin
  // and would otherwise be clipped by the viewBox.
  const W = 1000, H = 172, L = 34, R = 18, TOP = 20, BOT = 118;
  const span = CLOSE - OPEN;
  const x = (min: number) => L + ((Math.min(Math.max(min, OPEN), CLOSE) - OPEN) / span) * (W - L - R);
  /** Scores run −100…100; clamp so a runaway value cannot escape the frame. */
  const y = (score: number) => {
    const mid = (TOP + BOT) / 2;
    return mid - (Math.max(-100, Math.min(100, score)) / 100) * ((BOT - TOP) / 2);
  };
  const nowMin = etMinutes(new Date().toISOString());

  const ticks: number[] = [];
  for (let m = OPEN; m <= CLOSE; m += 30) ticks.push(m);

  /** One point per bar, in session order. */
  const pts = events
    .map((e) => ({ e, min: barMinutes(e), score: e.score }))
    .sort((a, b) => a.min - b.min);

  /**
   * Break the line wherever more than ~2 bars are missing. Drawing straight
   * through a 40-minute outage would render the gap as a smooth trend, which is
   * the one thing the operator must not be shown.
   */
  const segments: { min: number; score: number }[][] = [];
  let run: { min: number; score: number }[] = [];
  for (const p of pts) {
    const prev = run[run.length - 1];
    if (prev && p.min - prev.min > 25) { segments.push(run); run = []; }
    run.push({ min: p.min, score: p.score });
  }
  if (run.length) segments.push(run);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]" role="img"
        aria-label="Conviction score and decisions across the session">
        {/* half-hour grid */}
        {ticks.map((m) => (
          <g key={m}>
            <line x1={x(m)} y1={TOP - 6} x2={x(m)} y2={BOT + 22} stroke="currentColor" className="text-border" strokeWidth={1} />
            <text x={x(m)} y={H - 6} textAnchor="middle" className="fill-current text-text-secondary" fontSize={10}>
              {ptTick(m)}
            </text>
          </g>
        ))}

        {/* score bands: ±100 edges, 0 centre. The centre line is heavier because
            a score crossing it is the moment the thesis changes side. */}
        {[100, 50, -50, -100].map((s) => (
          <g key={s}>
            <line x1={L} y1={y(s)} x2={W - R} y2={y(s)} stroke="currentColor" className="text-border" strokeWidth={0.5} strokeDasharray="2 3" />
            <text x={L - 4} y={y(s) + 3} textAnchor="end" className="fill-current text-dim" fontSize={8}>{s > 0 ? `+${s}` : s}</text>
          </g>
        ))}
        <line x1={L} y1={y(0)} x2={W - R} y2={y(0)} stroke="currentColor" className="text-text-secondary" strokeWidth={1} />
        <text x={L - 4} y={y(0) + 3} textAnchor="end" className="fill-current text-text-secondary" fontSize={8}>0</text>
        <text x={L} y={12} className="fill-current text-text-secondary" fontSize={9}>CONVICTION SCORE</text>

        {/* the score line */}
        {segments.map((seg, i) => (
          <polyline key={i} fill="none" stroke="currentColor" className="text-text-primary" strokeWidth={1.5}
            points={seg.map((p) => `${x(p.min)},${y(p.score)}`).join(" ")} />
        ))}

        {/* every bar gets a dot, so a silent HOLD is still visibly a heartbeat */}
        {pts.map((p, i) => (
          <circle key={`d${i}`} cx={x(p.min)} cy={y(p.score)} r={1.8}
            className={toneOf({ score: p.score })} fill="currentColor" opacity={0.8}>
            <title>{`${fmtTimePT(p.e.receivedAt)} — ${p.e.signal} · score ${p.e.score} · ${p.e.legsAgree}/6 legs`}</title>
          </circle>
        ))}

        {segments.length === 0 && (
          <text x={L + 60} y={y(0) - 6} className="fill-current text-dim" fontSize={10}>
            no conviction alerts recorded for this day
          </text>
        )}

        {/* Decision pins — filled alerted, hollow was a silent decision. */}
        {pts.filter((p) => PINNED.has(p.e.signal)).map((p, i) => {
          const px = x(p.min);
          return (
            <g key={`p${i}`}>
              <line x1={px} y1={y(p.score)} x2={px} y2={BOT + 8} stroke="currentColor"
                className={toneOf(p.e)} strokeWidth={1} opacity={0.5} />
              <circle cx={px} cy={BOT + 12} r={3.5} className={toneOf(p.e)}
                fill={p.e.notified ? "currentColor" : "var(--color-bg-card, #fff)"}
                stroke="currentColor" strokeWidth={1.5}>
                <title>{`${fmtTimePT(p.e.receivedAt)} ${p.e.signal}${p.e.notified ? " (alerted)" : " (silent)"}\n${p.e.line}`}</title>
              </circle>
            </g>
          );
        })}

        {/* now */}
        {isToday && nowMin >= OPEN && nowMin <= CLOSE && (
          <line x1={x(nowMin)} y1={TOP - 6} x2={x(nowMin)} y2={BOT + 22} stroke="currentColor"
            className="text-text-primary" strokeWidth={1} strokeDasharray="2 2" />
        )}
      </svg>
    </div>
  );
}

// ─── EOD research ────────────────────────────────────────────────────────────

/**
 * The narrative is the only model-written text on this page, so it gets the
 * smallest renderer that reads well and cannot execute anything: headings,
 * bullets, bold. No markdown library, no dangerouslySetInnerHTML.
 */
function Markdownish({ text }: { text: string }) {
  const blocks = text.split("\n");
  const bold = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={i}>{part.slice(2, -2)}</strong>
        : <span key={i}>{part}</span>);
  return (
    <div className="space-y-1.5">
      {blocks.map((line, i) => {
        const t = line.trim();
        if (!t) return null;
        if (t.startsWith("## ")) return <div key={i} className="font-bold text-sm pt-1">{t.slice(3)}</div>;
        if (t.startsWith("# ")) return <div key={i} className="font-bold text-sm pt-1">{t.slice(2)}</div>;
        if (/^[-*]\s/.test(t)) return (
          <div key={i} className="flex gap-2 text-xs leading-relaxed">
            <span className="text-dim shrink-0">·</span><span>{bold(t.replace(/^[-*]\s/, ""))}</span>
          </div>);
        return <p key={i} className="text-xs leading-relaxed">{bold(t)}</p>;
      })}
    </div>
  );
}

function ResearchSection({ report }: { report: SpyResearchReport | null }) {
  const [open, setOpen] = useState(false);
  const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;

  return (
    <div className="bg-bg-card border border-border rounded">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full text-left card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary flex items-center gap-2">
        <span>EOD research</span>
        {report ? (
          <span className={`normal-case font-normal ${report.sufficient ? "text-text-secondary" : "text-signal-bear"}`}>
            · {report.closedTrades} closed trades{report.sufficient ? "" : ` (needs ${report.minTrades} to rank variants)`}
          </span>
        ) : (
          <span className="normal-case font-normal text-text-secondary">· not run for this day</span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] normal-case font-normal text-text-secondary">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        report === null ? (
          <div className="px-3 py-4 text-xs text-text-secondary">
            No report for this day. It is generated after the close by{" "}
            <code className="text-[11px]">tools/streak-research/research.mjs</code>, which replays the
            day&apos;s BUY → SELL signals against real SPY option bars.
          </div>
        ) : (
          <div className="px-3 py-3 space-y-3">
            <Markdownish text={report.narrative} />

            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-text-secondary">
                  <tr className="border-b border-border">
                    <th className="text-left font-normal py-1 pr-3">Rule set</th>
                    <th className="text-left font-normal py-1 pr-3">Instrument</th>
                    <th className="text-right font-normal py-1 pr-3">Signals</th>
                    <th className="text-right font-normal py-1 pr-3">Closed</th>
                    <th className="text-right font-normal py-1 pr-3">Net $/contract</th>
                    <th className="text-right font-normal py-1 pr-3">Win %</th>
                    <th className="text-right font-normal py-1">Avg %</th>
                  </tr>
                </thead>
                <tbody>
                  {report.variants.map((v, i) => (
                    <tr key={i} className={`border-b border-border/40 last:border-b-0 ${v.rules === "live" ? "bg-bg-primary/40" : ""}`}>
                      <td className="py-1 pr-3 whitespace-nowrap" title={v.rulesLabel}>
                        {v.rules === "live" ? <strong>{v.rules}</strong> : v.rules}
                      </td>
                      <td className="py-1 pr-3 whitespace-nowrap text-text-secondary">{v.instrument}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{v.signals}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{v.realisedTrades}</td>
                      <td className={`py-1 pr-3 text-right tabular-nums ${v.realisedTrades ? (v.netPerContract >= 0 ? "text-signal-bull" : "text-signal-bear") : "text-dim"}`}>
                        {v.realisedTrades ? money(v.netPerContract) : "—"}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums text-text-secondary">{v.winRate ?? "—"}</td>
                      <td className="py-1 text-right tabular-nums text-text-secondary">{v.avgPct ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-[10px] text-dim">
              Generated {new Date(report.generatedAt).toLocaleString()} · fills are the next bar&apos;s open
              after each signal · P&amp;L is one contract · the numbers are computed deterministically, only the
              commentary is model-written.
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ─── Shadow ledger ───────────────────────────────────────────────────────────
//
// Every accepted BUY, scored after the close against ONE fixed rule that lives
// in api/src/lib/spyShadow/rule.ts and is applied by the 4:20 PM ET cron. The
// rows accumulate for as long as the table exists, so the operator can judge
// the rule on trades it has never seen — which is the only test that counts.
// Nothing here is traded. The view performs no arithmetic beyond formatting
// and a per-day sum of the rows it is showing.

const usd = (n: number | null | undefined, dp = 0) =>
  n === null || n === undefined ? "—" : `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(dp)}`;
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;
const tone = (n: number | null | undefined) =>
  n === null || n === undefined ? "text-dim" : n > 0 ? "text-signal-bull" : n < 0 ? "text-signal-bear" : "text-text-secondary";

/** A UTC "HH:MM" on a given day → Pacific clock for display. */
function utcMinuteToPT(day: string, hhmm: string): string {
  return hhmm ? fmtTimePT(`${day}T${hhmm}:00Z`) : "";
}

/** ET "YYYY-MM-DD HH:MM:SS" bar time → Pacific clock for display. */
function barTimeToPT(barTime: string): string {
  const [d, t] = barTime.split(" ");
  if (!d || !t) return barTime;
  const guess = Date.parse(`${d}T${t}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(guess));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const offset = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - guess;
  return fmtTimePT(new Date(guess - offset).toISOString());
}

function EquityCurve({ points }: { points: { day: string; netUsd: number }[] }) {
  if (points.length < 2) return <div className="text-[10px] text-dim">The curve appears after two trading days.</div>;
  const W = 640, H = 96, L = 44, R = 8, TOP = 8, BOT = H - 18;
  const vals = points.map((p) => p.netUsd);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i: number) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v: number) => TOP + ((hi - v) * (BOT - TOP)) / span;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.netUsd).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const cls = last.netUsd >= 0 ? "text-signal-bull" : "text-signal-bear";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" role="img" aria-label="cumulative net dollars per contract">
      <line x1={L} y1={y(0)} x2={W - R} y2={y(0)} stroke="currentColor" className="text-text-secondary" strokeWidth={1} />
      <text x={L - 4} y={y(hi) + 3} textAnchor="end" className="fill-current text-text-secondary" fontSize={9}>{usd(hi)}</text>
      <text x={L - 4} y={y(lo) + 3} textAnchor="end" className="fill-current text-text-secondary" fontSize={9}>{usd(lo)}</text>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className={cls} />
      <circle cx={x(points.length - 1)} cy={y(last.netUsd)} r={2.5} fill="currentColor" className={cls} />
      <text x={L} y={H - 4} className="fill-current text-dim" fontSize={9}>{points[0].day}</text>
      <text x={W - R} y={H - 4} textAnchor="end" className="fill-current text-dim" fontSize={9}>{last.day}</text>
    </svg>
  );
}

function Stat({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="bg-bg-primary/40 border border-border rounded px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${cls ?? "text-text-primary"}`}>{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

function ShadowSection({ shadow, date, isToday, onReevaluate, busy, error }: {
  shadow: SpyShadowResponse | null; date: string; isToday: boolean;
  onReevaluate: () => void; busy: boolean; error: string | null;
}) {
  const [open, setOpen] = useState(true);
  const s = shadow?.summary;
  const rows: ShadowTrade[] = shadow?.rows ?? [];
  const dayNet = rows.reduce((a, r) => a + (r.acct?.netUsd ?? 0), 0);
  const dayFilled = rows.filter((r) => r.status === "FILLED").length;
  const acctSize = shadow?.params.accountUsd ?? 0;

  return (
    <div className="bg-bg-card border border-border rounded">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full text-left card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary flex items-center gap-2">
        <span>Shadow ledger</span>
        {s ? (
          <span className="normal-case font-normal text-text-secondary">
            · {s.filled} trades over {s.days} days · <span className={tone(s.account.netUsd)}>{usd(s.account.netUsd)}</span>
            {" "}({pct(s.account.retPct)}) on ${s.account.sizeUsd.toLocaleString()}
          </span>
        ) : error ? (
          <span className="normal-case font-normal text-signal-bear">· {error}</span>
        ) : (
          <span className="normal-case font-normal text-text-secondary">· loading…</span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] normal-case font-normal text-text-secondary">{open ? "hide" : "show"}</span>
      </button>

      {open && shadow && s && (
        <div className="px-3 py-3 space-y-3">
          <div className="text-[11px] text-text-secondary">
            Rule, fixed in code: <span className="text-text-primary">{shadow.rule}</span>. ATM SPY option expiring that
            Friday, sized as every contract a <span className="text-text-primary">${s.account.sizeUsd.toLocaleString()}</span> account
            buys at the entry (not compounded), scored after the close. Nothing is traded.
          </div>

          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Stat label={`Net on $${s.account.sizeUsd.toLocaleString()}`} value={`${usd(s.account.netUsd)} · ${pct(s.account.retPct)}`} cls={tone(s.account.netUsd)}
              sub={s.account.commissionUsd ? `gross ${usd(s.account.grossUsd)} · fees ${usd(-s.account.commissionUsd)}` : "commission-free (Tradier Pro, $10/mo flat not modelled)"} />
            <Stat label="Win rate" value={s.winRate === null ? "—" : `${s.winRate}%`} sub={`${s.wins}W / ${s.losses}L`} />
            <Stat label="Best / worst trade" value={`${usd(s.account.bestTradeUsd)} / ${usd(s.account.worstTradeUsd)}`}
              sub={`avg ${s.account.avgContracts ?? "—"} contracts`} />
            <Stat label="Max drawdown" value={`${usd(s.account.maxDrawdownUsd)} · ${pct(s.account.maxDrawdownPct)}`} cls={tone(s.account.maxDrawdownUsd)} sub="on closing equity" />
            <Stat label="Calls / puts" value={`${usd(s.account.bySide.CALL)} / ${usd(s.account.bySide.PUT)}`}
              sub={`${s.bySide.CALL.wins}/${s.bySide.CALL.filled} · ${s.bySide.PUT.wins}/${s.bySide.PUT.filled} won`} />
            <Stat label="Signals" value={`${s.signals}`}
              sub={`${s.filled} filled · ${s.noTouch} no touch${s.noData ? ` · ${s.noData} no data` : ""}`} />
          </div>

          <div className="overflow-x-auto"><EquityCurve points={s.account.equity} /></div>
          <div className="text-[10px] text-dim">
            Per single contract: {usd(s.netUsd)} net · avg win {usd(s.avgWinUsd)} / avg loss {usd(s.avgLossUsd)} gross · drawdown {usd(s.maxDrawdownUsd)}
          </div>
          <div className="text-[10px] text-dim">
            Exits: {s.byExit.TP} target · {s.byExit.SL} stop · {s.byExit.EOD} close
            {shadow.firstDay ? ` · since ${shadow.firstDay}` : ""}
            {shadow.lastEvaluated ? ` · last scored ${fmtTimePT(shadow.lastEvaluated)} ${PT_LABEL}` : ""}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary">
              {date}
              {rows.length
                ? <> · {dayFilled} of {rows.length} filled · <span className={tone(dayNet)}>{usd(dayNet, 2)}</span>
                    {acctSize ? <span className="text-dim"> ({pct((dayNet / acctSize) * 100)})</span> : null}</>
                : " · no rows"}
            </div>
            <span className="flex-1" />
            <button onClick={onReevaluate} disabled={busy}
              title={isToday ? "Scores after the close; before ~4:15 PM ET it sees an incomplete session." : "Re-score this day. Overwrites the same rows."}
              className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary disabled:opacity-40">
              {busy ? "scoring…" : rows.length ? "re-score day" : "score day"}
            </button>
          </div>
          {error && <div className="text-[11px] text-signal-bear">{error}</div>}

          {rows.length === 0 ? (
            <div className="text-xs text-text-secondary">
              {isToday
                ? "Today's BUY alerts are scored by the 4:20 PM ET cron once the session is closed."
                : "No BUY alerts were scored for this day."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-text-secondary">
                  <tr className="border-b border-border">
                    <th className="text-left font-normal py-1 pr-3">Alert</th>
                    <th className="text-left font-normal py-1 pr-3">Side</th>
                    <th className="text-left font-normal py-1 pr-3">Contract</th>
                    <th className="text-left font-normal py-1 pr-3">Touch</th>
                    <th className="text-right font-normal py-1 pr-3">Entry</th>
                    <th className="text-right font-normal py-1 pr-3">Exit</th>
                    <th className="text-left font-normal py-1 pr-3">Why</th>
                    <th className="text-right font-normal py-1 pr-3">Ret</th>
                    <th className="text-right font-normal py-1 pr-3">Qty</th>
                    <th className="text-right font-normal py-1 pr-3">Net $</th>
                    <th className="text-right font-normal py-1 pr-3">Acct %</th>
                    <th className="text-right font-normal py-1 pr-3">Held</th>
                    <th className="text-right font-normal py-1 pr-3">Peak</th>
                    <th className="text-left font-normal py-1">10 / 15%</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.barHhmm}|${r.side}`} className="border-b border-border/40 last:border-b-0">
                      <td className="py-1 pr-3 whitespace-nowrap tabular-nums"
                        title={`bar ${r.barHhmm} ET · score ${r.signalScore} · ${r.entryTrigger}`}>
                        {barTimeToPT(r.barTime)}
                      </td>
                      <td className={`py-1 pr-3 font-semibold ${r.side === "CALL" ? "text-signal-bull" : "text-signal-bear"}`}>{r.side}</td>
                      <td className="py-1 pr-3 whitespace-nowrap text-text-secondary">{r.contract}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">
                        {r.touchMinuteUtc
                          ? <span title={`EMA ${r.emaAtTouch ?? "—"} · SPY ${r.spyAtTouch ?? "—"}`}>
                              {utcMinuteToPT(r.day, r.touchMinuteUtc)} <span className="text-dim">+{r.waitedMin}m</span>
                            </span>
                          : r.status === "NO_TOUCH"
                            ? <span className="text-text-secondary">no touch in 10m</span>
                            : <span className="text-signal-bear" title={r.note}>no data</span>}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.entry?.toFixed(2) ?? "—"}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.exit?.toFixed(2) ?? "—"}</td>
                      <td className={`py-1 pr-3 ${r.exitReason === "TP" ? "text-signal-bull" : r.exitReason === "SL" ? "text-signal-bear" : "text-text-secondary"}`}>
                        {r.exitReason === "TP" ? "target" : r.exitReason === "SL" ? "stop" : r.exitReason === "EOD" ? "close" : r.status === "NO_DATA" ? r.note : ""}
                      </td>
                      <td className={`py-1 pr-3 text-right tabular-nums ${tone(r.retPct)}`}>{pct(r.retPct)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-text-secondary"
                        title={r.acct ? `${r.acct.contracts} × ${r.entry?.toFixed(2)} × 100 = $${r.acct.costUsd.toLocaleString()} of $${acctSize.toLocaleString()}` : ""}>
                        {r.acct ? r.acct.contracts : "—"}
                      </td>
                      <td className={`py-1 pr-3 text-right tabular-nums ${tone(r.acct?.netUsd)}`}
                        title={r.acct ? `per contract ${usd(r.netUsd, 2)}` : ""}>{usd(r.acct?.netUsd, 2)}</td>
                      <td className={`py-1 pr-3 text-right tabular-nums ${tone(r.acct?.retPct)}`}>{pct(r.acct?.retPct)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-text-secondary">{r.heldMin === null ? "—" : `${r.heldMin}m`}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-text-secondary">{pct(r.mfePct)}</td>
                      <td className="py-1 text-text-secondary">
                        {r.status === "FILLED" ? `${r.tp10Hit ? "✓" : "·"} / ${r.tp15Hit ? "✓" : "·"}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[10px] text-dim mt-1">
                Times {PT_LABEL} · entry is the option&apos;s 1-minute midpoint at the touch · the stop is checked before
                the target inside a bar · Qty is every contract ${acctSize.toLocaleString()} buys at the entry · Net $ and Acct %
                are for that quantity{shadow.params.commissionRt ? " after commissions" : ", commission-free"} · &ldquo;10 / 15%&rdquo; marks whether those targets would have filled before the stop
                {rows.some((r) => r.backfilled) ? " · this day was backfilled from the alert log" : ""}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function SpyConvictionPage() {
  const [date, setDate] = useState<string>(tradingDay);
  const [data, setData] = useState<SpyConvictionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHits, setShowHits] = useState(false);
  const [showSilent, setShowSilent] = useState(false);
  const [shadow, setShadow] = useState<SpyShadowResponse | null>(null);
  const [shadowBusy, setShadowBusy] = useState(false);
  const [shadowError, setShadowError] = useState<string | null>(null);
  /** Two views of the same tab: the live ledger, and the explanation of the system. */
  const [view, setView] = useState<"ledger" | "how">("ledger");

  const load = useCallback(async (d: string) => {
    setLoading(true); setError(null);
    try { setData(await getSpyConviction(d)); }
    catch (e) { setError(e instanceof Error ? e.message : "failed to load"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  const loadShadow = useCallback(async (d: string) => {
    setShadowError(null);
    try { setShadow(await getSpyShadow(d)); }
    catch (e) { setShadowError(e instanceof Error ? e.message : "ledger failed to load"); }
  }, []);
  useEffect(() => { void loadShadow(date); }, [date, loadShadow]);

  const onReevaluate = async () => {
    setShadowBusy(true); setShadowError(null);
    try { await evaluateSpyShadow(date); await loadShadow(date); }
    catch (e) { setShadowError(e instanceof Error ? e.message : "could not score the day"); }
    finally { setShadowBusy(false); }
  };

  // The page's job is "is it alive right now", so it must not go stale itself.
  useEffect(() => {
    if (date !== tradingDay()) return;
    const t = setInterval(() => void load(date), 60_000);
    return () => clearInterval(t);
  }, [date, load]);

  const isToday = date === tradingDay();

  const { latest, alerted, silent, rejected, anomalies } = useMemo(() => {
    const events = data?.events ?? [];
    return {
      latest: events.length ? events[events.length - 1] : null,
      alerted: events.filter((e) => e.notified).length,
      silent: events.filter((e) => !e.notified).length,
      rejected: (data?.hits ?? []).filter((h) => h.decision.startsWith("rejected") || h.decision === "deadletter"),
      anomalies: events.filter((e) => e.anomaly),
    };
  }, [data]);

  const onFlat = async () => {
    setBusy(true);
    try { await forceSpyFlat(); await load(date); }
    catch (e) { setError(e instanceof Error ? e.message : "could not reset"); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <div className="text-center py-16 text-sm text-text-secondary">Loading SPY conviction …</div>;
  if (error && !data) return <div className="text-center py-16 text-sm text-signal-bear">{error}</div>;
  if (!data) return null;

  const shown = showSilent ? data.events : data.events.filter((e) => e.notified || e.anomaly);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">SPY Conviction</h1>
          <p className="text-xs text-text-secondary">
            Six breadth and price legs scored on closed 10-minute SPY bars, from TradingView.
            Alerts only — nothing is traded, sized or staged.
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5">
          {([["ledger", "Ledger"], ["how", "How it works"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                view === k ? "bg-text-primary text-bg-primary border-text-primary" : "border-border text-text-secondary hover:text-text-primary"
              }`}>
              {label}
            </button>
          ))}
        </div>
        {view === "ledger" && (
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-secondary">
            day
            <input type="date" value={date} max={tradingDay()} onChange={(e) => setDate(e.target.value || tradingDay())}
              className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary" />
          </label>
        )}
      </div>

      {view === "how" && <SpyHowItWorks params={shadow?.params ?? null} rule={shadow?.rule ?? null} />}

      {view === "ledger" && <>

      {/* Live state. Everything here answers "is it alive". */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Latest score</div>
          <div className={`text-sm font-bold ${latest ? toneOf({ score: latest.score }) : "text-dim"}`}>
            {latest ? `${latest.score > 0 ? "+" : ""}${latest.score}` : "—"}
            {latest && <span className="font-normal text-text-secondary"> · {latest.legsAgree}/6 legs</span>}
          </div>
          <div className="text-[10px] text-text-secondary">
            {latest ? [latest.grade, latest.bias].filter(Boolean).join(" · ") || "no grade" : "no bars yet"}
          </div>
          <div className="text-[10px] text-dim">
            {latest ? `bar ${barLabelPT(latest)} ${PT_LABEL} · ${latest.signal}` : ""}
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Believed position</div>
          <div className={`text-sm font-bold ${toneOf({ state: data.state })}`}>{STATE_LABEL[data.state]}</div>
          <div className="text-[10px] text-text-secondary">
            {data.state === "FLAT"
              ? "nothing open"
              : `since ${fmtTimePT(data.since)}${data.entryPx ? ` · SPY ${data.entryPx}` : ""}`}
          </div>
          {data.state !== "FLAT" && (
            <button onClick={onFlat} disabled={busy}
              className="mt-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary disabled:opacity-40">
              {busy ? "resetting…" : "force flat"}
            </button>
          )}
        </div>

        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Last TradingView contact</div>
          <div className={`text-sm font-bold ${data.lastTradingViewContact ? "text-text-primary" : "text-signal-bear"}`}>
            {data.lastTradingViewContact ? fmtTimePT(data.lastTradingViewContact) : "never"}
          </div>
          <div className="text-[10px] text-text-secondary">
            {data.lastTradingViewContact ? ago(data.lastTradingViewContact) : "no alert has ever reached the endpoint"}
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Today</div>
          <div className="text-sm font-bold">{data.events.length} bars</div>
          <div className="text-[10px] text-text-secondary">{alerted} alerted · {silent} silent</div>
          {rejected.length > 0 && (
            <div className="text-[10px] text-signal-bear font-semibold">{rejected.length} rejected / unreadable</div>
          )}
          {anomalies.length > 0 && (
            <div className="text-[10px] text-signal-bear font-semibold">{anomalies.length} out of order</div>
          )}
        </div>
      </div>

      {/* An out-of-order signal means a step went missing — the state below is a
          belief, and this is the one thing that tells you it may be wrong. */}
      {anomalies.length > 0 && (
        <div className="bg-bg-card border border-signal-bear/60 rounded px-3 py-2 text-xs">
          <span className="font-semibold text-signal-bear">
            {anomalies.length} signal{anomalies.length === 1 ? "" : "s"} arrived out of order
          </span>
          <span className="text-text-secondary">
            {" "}— the position below is a belief and may have drifted. Latest: {anomalies[anomalies.length - 1].anomalyDetail}
          </span>
        </div>
      )}

      <div className="bg-bg-card border border-border rounded px-3 py-2">
        <div className="card-header pb-1.5 border-b-2 border-text-primary mb-2">
          Session timeline
          <span className="font-normal normal-case text-text-secondary">
            {" "}· all times {PT_LABEL} · line is the score, pins are decisions (filled = alerted)
          </span>
        </div>
        <Timeline events={data.events} isToday={isToday} />
      </div>

      <div className="bg-bg-card border border-border rounded">
        <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary flex items-center gap-2">
          <span>Decisions</span>
          <span className="flex-1" />
          <button onClick={() => setShowSilent((v) => !v)}
            className="text-[10px] normal-case font-normal text-text-secondary hover:text-text-primary">
            {showSilent ? `hide the ${silent} silent bars` : `show all ${data.events.length} bars`}
          </button>
        </div>
        {shown.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-secondary">
            {data.events.length === 0
              ? <>No conviction alerts on {date}. If that surprises you, check &ldquo;last TradingView contact&rdquo;
                  above — <em>never</em> means the alerts are not reaching us at all.</>
              : <>Nothing alerted on {date}; all {data.events.length} bars were HOLD or STAND_ASIDE. Use
                  &ldquo;show all bars&rdquo; to see them.</>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-text-secondary">
                <tr className="border-b border-border">
                  <th className="text-left font-normal px-3 py-1">Bar</th>
                  <th className="text-left font-normal px-3 py-1">Signal</th>
                  <th className="text-right font-normal px-3 py-1">Score</th>
                  <th className="text-right font-normal px-3 py-1">Legs</th>
                  <th className="text-left font-normal px-3 py-1">Trigger</th>
                  <th className="text-right font-normal px-3 py-1">SPY</th>
                  <th className="text-left font-normal px-3 py-1">State</th>
                  <th className="text-left font-normal px-3 py-1">Alerted</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr key={i} className={`border-b border-border/40 last:border-b-0 ${e.anomaly ? "bg-signal-bear/5" : ""}`}>
                    <td className="px-3 py-1 whitespace-nowrap tabular-nums"
                      title={`bar ${e.barHhmm} ET · arrived ${fmtTimePT(e.receivedAt)} ${PT_LABEL}`}>
                      {barLabelPT(e)}
                    </td>
                    <td className={`px-3 py-1 whitespace-nowrap font-semibold ${toneOf(e)}`}>{e.signal}</td>
                    <td className={`px-3 py-1 text-right tabular-nums ${toneOf({ score: e.score })}`}>
                      {e.score > 0 ? "+" : ""}{e.score}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{e.legsAgree}/6</td>
                    <td className="px-3 py-1 text-text-secondary">
                      {e.entryTrigger && e.entryTrigger !== "none"
                        ? `${e.entryTrigger}${e.entryDistAtr ? ` @${e.entryDistAtr} ATR` : ""}`
                        : e.blockReason && e.blockReason !== "none" ? e.blockReason : "—"}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{e.spy || "—"}</td>
                    <td className="px-3 py-1 whitespace-nowrap text-text-secondary">
                      {e.stateFrom === e.stateTo ? e.stateTo : `${e.stateFrom} → ${e.stateTo}`}
                      {e.anomaly && <span className="text-signal-bear font-semibold"> ⚠</span>}
                    </td>
                    <td className="px-3 py-1">
                      {e.notified ? <span className="text-signal-bull">sent</span> : <span className="text-dim">silent</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Raw hits. Rejects live here, and they are the difference between
          "quiet market" and "wrong secret" — which look identical on a phone. */}
      <div className="bg-bg-card border border-border rounded">
        <button onClick={() => setShowHits((v) => !v)}
          className="w-full text-left card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary flex items-center gap-2">
          <span>Raw hits ({data.hits.length})</span>
          {rejected.length > 0 && <span className="text-signal-bear normal-case font-normal">· {rejected.length} rejected</span>}
          <span className="flex-1" />
          <span className="text-[10px] normal-case font-normal text-text-secondary">{showHits ? "hide" : "show"}</span>
        </button>
        {showHits && (
          data.hits.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-secondary">Nothing has posted to the webhook on {date}.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <tbody>
                  {data.hits.map((h, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-b-0">
                      <td className="px-3 py-1 whitespace-nowrap tabular-nums">{fmtTimePT(h.receivedAt)}</td>
                      <td className="px-3 py-1 whitespace-nowrap text-text-secondary">{h.ip}</td>
                      <td className="px-3 py-1 whitespace-nowrap">
                        {h.fromTradingView ? <span className="text-text-secondary">TradingView</span> : <span className="text-signal-bear">other source</span>}
                      </td>
                      <td className={`px-3 py-1 whitespace-nowrap font-semibold ${h.decision.startsWith("rejected") || h.decision === "deadletter" ? "text-signal-bear" : "text-text-primary"}`}>
                        {h.decision}
                      </td>
                      <td className="px-3 py-1 text-text-secondary">{h.reason ?? h.signal ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      <ShadowSection shadow={shadow} date={date} isToday={isToday}
        onReevaluate={onReevaluate} busy={shadowBusy} error={shadowError} />

      <ResearchSection report={data.research} />
      </>}
    </div>
  );
}
