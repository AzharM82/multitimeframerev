import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpyStreakResponse, SpyStreakEvent, SpyRegimeSample } from "../types.js";
import { getSpyStreak, forceSpyFlat } from "../services/api.js";

/**
 * SPY Streak — the window into the breadth-streak system.
 *
 * WHY THIS EXISTS: the system is alerts-only, and by design most events produce
 * NO alert — a green_end on a bullish day is a pause, a counter-trend streak is
 * suppressed. That is correct behaviour, but from the operator's phone a healthy
 * quiet system and a dead one look identical. On 2026-08-10 a real TradingView
 * streak arrived, was correctly suppressed, and the only way to know any of that
 * had happened was to query table storage by hand.
 *
 * So this page is built around ONE question — "is it alive, and what did it
 * decide?" — and it shows the silent decisions and the rejected hits with the
 * same prominence as the alerts. A rejected secret must never look like a quiet
 * market.
 */

const ET = "America/New_York";
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: ET });

/** Minutes since ET midnight — the x-axis unit for the timeline. */
function etMinutes(iso: string): number {
  const t = new Date(iso).toLocaleTimeString("en-GB", { timeZone: ET, hour12: false });
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

const TONE: Record<string, string> = {
  bullish: "text-signal-bull",
  bearish: "text-signal-bear",
  neutral: "text-text-secondary",
};

const ago = (iso: string | null) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return null;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h${String(mins % 60).padStart(2, "0")}m ago` : `${Math.floor(h / 24)}d ago`;
};

// ─── The timeline ────────────────────────────────────────────────────────────

interface Span { trend: "green" | "red"; from: number; to: number; open: boolean }

/**
 * Pair trend_start with the matching trend_end to get drawable spans.
 *
 * A start with no end is still drawn, running to "now" and flagged open — an
 * unfinished streak is the single most interesting thing on the page, and
 * dropping it because its partner has not arrived would hide exactly that.
 */
function toSpans(events: SpyStreakEvent[], nowMin: number): Span[] {
  const spans: Span[] = [];
  const openOf: Record<string, number | null> = { green: null, red: null };
  for (const e of events) {
    const m = etMinutes(e.receivedAt);
    if (e.event === "trend_start") {
      if (openOf[e.trend] === null) openOf[e.trend] = m;
    } else {
      const from = openOf[e.trend];
      if (from !== null) { spans.push({ trend: e.trend, from, to: m, open: false }); openOf[e.trend] = null; }
      else spans.push({ trend: e.trend, from: Math.max(OPEN, m - 5), to: m, open: false });
    }
  }
  for (const t of ["green", "red"] as const) {
    if (openOf[t] !== null) spans.push({ trend: t, from: openOf[t]!, to: Math.max(openOf[t]! + 5, nowMin), open: true });
  }
  return spans;
}

function Timeline({ spans, samples, events, isToday }: {
  spans: Span[]; samples: SpyRegimeSample[]; events: SpyStreakEvent[]; isToday: boolean;
}) {
  // L leaves room for the 9:30 tick label, which is centred on the axis origin
  // and would otherwise be clipped by the viewBox.
  const W = 1000, H = 132, L = 34, R = 18;
  const span = CLOSE - OPEN;
  const x = (min: number) => L + ((Math.min(Math.max(min, OPEN), CLOSE) - OPEN) / span) * (W - L - R);
  const nowMin = etMinutes(new Date().toISOString());

  const ticks: number[] = [];
  for (let m = OPEN; m <= CLOSE; m += 30) ticks.push(m);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]" role="img"
        aria-label="Streak and regime timeline for the session">
        {/* half-hour grid */}
        {ticks.map((m) => (
          <g key={m}>
            <line x1={x(m)} y1={14} x2={x(m)} y2={H - 20} stroke="currentColor" className="text-border" strokeWidth={1} />
            <text x={x(m)} y={H - 6} textAnchor="middle" className="fill-current text-text-secondary" fontSize={10}>
              {`${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")}`}
            </text>
          </g>
        ))}

        {/* REGIME lane — one tick per refresh, so a gap means the cron stopped
            rather than the regime holding steady. That distinction is the point. */}
        <text x={L} y={11} className="fill-current text-text-secondary" fontSize={9}>REGIME</text>
        {samples.map((s, i) => {
          const next = samples[i + 1];
          const from = etMinutes(s.capturedAt);
          const to = next ? etMinutes(next.capturedAt) : Math.min(from + 15, isToday ? nowMin : CLOSE);
          const cls = s.direction === "bullish" ? "text-signal-bull" : s.direction === "bearish" ? "text-signal-bear" : "text-dim";
          return (
            <rect key={s.capturedAt} x={x(from)} y={18} width={Math.max(1.5, x(to) - x(from))} height={16}
              className={cls} fill="currentColor" opacity={s.decision === "NO" ? 0.25 : 0.65}>
              <title>{`${hhmm(s.capturedAt)} — ${s.label} · Gate ${s.decision} · quality ${s.qualityScore}`}</title>
            </rect>
          );
        })}
        {samples.length === 0 && (
          <text x={L + 54} y={31} className="fill-current text-dim" fontSize={10}>
            no regime samples for this day
          </text>
        )}

        {/* STREAK lane — bands from start to end. */}
        <text x={L} y={54} className="fill-current text-text-secondary" fontSize={9}>STREAKS</text>
        <line x1={L} y1={72} x2={W - R} y2={72} stroke="currentColor" className="text-border" strokeWidth={1} />
        {spans.map((s, i) => (
          <rect key={i} x={x(s.from)} y={60} width={Math.max(3, x(s.to) - x(s.from))} height={24} rx={2}
            className={s.trend === "green" ? "text-signal-bull" : "text-signal-bear"}
            fill="currentColor" opacity={s.open ? 0.45 : 0.8}
            stroke="currentColor" strokeWidth={s.open ? 1.5 : 0} strokeDasharray={s.open ? "3 2" : undefined}>
            <title>{`${s.trend.toUpperCase()} ${hhmm(new Date().toISOString())}`}</title>
          </rect>
        ))}
        {spans.length === 0 && (
          <text x={L + 54} y={75} className="fill-current text-dim" fontSize={10}>
            no streaks recorded for this day
          </text>
        )}

        {/* Event markers — a filled pin alerted, hollow was a silent decision. */}
        {events.map((e, i) => {
          const ex = x(etMinutes(e.receivedAt));
          return (
            <g key={i}>
              <line x1={ex} y1={88} x2={ex} y2={98} stroke="currentColor"
                className={e.trend === "green" ? "text-signal-bull" : "text-signal-bear"} strokeWidth={1.5} />
              <circle cx={ex} cy={101} r={3.5}
                className={e.trend === "green" ? "text-signal-bull" : "text-signal-bear"}
                fill={e.notified ? "currentColor" : "var(--color-bg-card, #fff)"}
                stroke="currentColor" strokeWidth={1.5}>
                <title>{`${hhmm(e.receivedAt)} ${e.trend} ${e.event} → ${e.action}${e.notified ? " (alerted)" : " (silent)"}\n${e.why}`}</title>
              </circle>
            </g>
          );
        })}

        {/* now */}
        {isToday && nowMin >= OPEN && nowMin <= CLOSE && (
          <line x1={x(nowMin)} y1={14} x2={x(nowMin)} y2={H - 20} stroke="currentColor"
            className="text-text-primary" strokeWidth={1} strokeDasharray="2 2" />
        )}
      </svg>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function SpyStreakPage() {
  const [date, setDate] = useState<string>(todayET);
  const [data, setData] = useState<SpyStreakResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHits, setShowHits] = useState(false);

  const load = useCallback(async (d: string) => {
    setLoading(true); setError(null);
    try { setData(await getSpyStreak(d)); }
    catch (e) { setError(e instanceof Error ? e.message : "failed to load"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  // The page's job is "is it alive right now", so it must not go stale itself.
  useEffect(() => {
    if (date !== todayET()) return;
    const t = setInterval(() => void load(date), 60_000);
    return () => clearInterval(t);
  }, [date, load]);

  const isToday = date === todayET();
  const nowMin = etMinutes(new Date().toISOString());
  const spans = useMemo(() => toSpans(data?.events ?? [], nowMin), [data, nowMin]);

  const onFlat = async () => {
    setBusy(true);
    try { await forceSpyFlat(); await load(date); }
    catch (e) { setError(e instanceof Error ? e.message : "could not reset"); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <div className="text-center py-16 text-sm text-text-secondary">Loading SPY streak …</div>;
  if (error && !data) return <div className="text-center py-16 text-sm text-signal-bear">{error}</div>;
  if (!data) return null;

  const r = data.regime;
  const stale = data.regimeAgeMin !== null && data.regimeAgeMin > 90;
  const rejected = data.hits.filter((h) => h.decision.startsWith("rejected"));
  const silent = data.events.filter((e) => !e.notified).length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">SPY Streak</h1>
          <p className="text-xs text-text-secondary">
            5-min breadth streaks from TradingView, qualified by the Gate's SPY regime. Alerts only — nothing is traded.
          </p>
        </div>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-secondary">
          day
          <input type="date" value={date} max={todayET()} onChange={(e) => setDate(e.target.value || todayET())}
            className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary" />
        </label>
      </div>

      {/* Live state. Everything here answers "is it alive". */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Regime</div>
          <div className={`text-sm font-bold ${r ? TONE[r.direction] : "text-dim"}`}>{r ? r.label : "unknown"}</div>
          <div className="text-[10px] text-text-secondary">
            {r ? `Gate ${r.decision} · quality ${r.qualityScore}` : "no regime on record"}
          </div>
          <div className={`text-[10px] ${stale ? "text-signal-bear font-semibold" : "text-dim"}`}>
            {r ? (stale ? `STALE — ${data.regimeAgeMin}m old, cron not refreshing` : `refreshed ${data.regimeAgeMin}m ago`) : ""}
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Believed position</div>
          <div className={`text-sm font-bold ${data.position === "CALLS" ? "text-signal-bull" : data.position === "PUTS" ? "text-signal-bear" : "text-text-secondary"}`}>
            {data.position}
          </div>
          <div className="text-[10px] text-text-secondary">
            {data.position === "FLAT" ? "nothing open" : `since ${hhmm(data.positionSince)} · ${data.entryRegime || "?"}`}
          </div>
          {data.position !== "FLAT" && (
            <button onClick={onFlat} disabled={busy}
              className="mt-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-border text-text-secondary hover:text-text-primary disabled:opacity-40">
              {busy ? "resetting…" : "force flat"}
            </button>
          )}
        </div>

        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Last TradingView contact</div>
          <div className={`text-sm font-bold ${data.lastTradingViewContact ? "text-text-primary" : "text-signal-bear"}`}>
            {data.lastTradingViewContact ? hhmm(data.lastTradingViewContact) : "never"}
          </div>
          <div className="text-[10px] text-text-secondary">
            {data.lastTradingViewContact ? ago(data.lastTradingViewContact) : "no alert has ever reached the endpoint"}
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Today</div>
          <div className="text-sm font-bold">{data.events.length} events</div>
          <div className="text-[10px] text-text-secondary">{silent} silent · {data.events.length - silent} alerted</div>
          {rejected.length > 0 && (
            <div className="text-[10px] text-signal-bear font-semibold">{rejected.length} rejected</div>
          )}
        </div>
      </div>

      <div className="bg-bg-card border border-border rounded px-3 py-2">
        <div className="card-header pb-1.5 border-b-2 border-text-primary mb-2">
          Session timeline
          <span className="font-normal normal-case text-text-secondary"> · bands are streaks, pins are decisions (filled = alerted)</span>
        </div>
        <Timeline spans={spans} samples={data.regimeSamples} events={data.events} isToday={isToday} />
      </div>

      <div className="bg-bg-card border border-border rounded">
        <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
          Decisions
          <span className="font-normal normal-case text-text-secondary"> · including the ones that deliberately said nothing</span>
        </div>
        {data.events.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-secondary">
            No streaks recorded on {date}. If that surprises you, check "last TradingView contact" above —
            never means the alerts are not reaching us at all.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-text-secondary">
                <tr className="border-b border-border">
                  <th className="text-left font-normal px-3 py-1">Time</th>
                  <th className="text-left font-normal px-3 py-1">Streak</th>
                  <th className="text-left font-normal px-3 py-1">Action</th>
                  <th className="text-left font-normal px-3 py-1">Position</th>
                  <th className="text-left font-normal px-3 py-1">Why</th>
                  <th className="text-left font-normal px-3 py-1">Alerted</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e, i) => (
                  <tr key={i} className="border-b border-border/40 last:border-b-0">
                    <td className="px-3 py-1 whitespace-nowrap tabular-nums">{hhmm(e.receivedAt)}</td>
                    <td className={`px-3 py-1 whitespace-nowrap font-semibold ${e.trend === "green" ? "text-signal-bull" : "text-signal-bear"}`}>
                      {e.trend === "green" ? "🟢" : "🔴"} {e.event === "trend_start" ? "start" : "end"}
                    </td>
                    <td className="px-3 py-1 whitespace-nowrap font-semibold">{e.action.replace(/_/g, " ")}</td>
                    <td className="px-3 py-1 whitespace-nowrap text-text-secondary">{e.positionBefore} → {e.positionAfter}</td>
                    <td className="px-3 py-1 text-text-secondary">{e.why}</td>
                    <td className="px-3 py-1">{e.notified ? <span className="text-signal-bull">sent</span> : <span className="text-dim">silent</span>}</td>
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
                      <td className="px-3 py-1 whitespace-nowrap tabular-nums">{hhmm(h.receivedAt)}</td>
                      <td className="px-3 py-1 whitespace-nowrap text-text-secondary">{h.ip}</td>
                      <td className="px-3 py-1 whitespace-nowrap">
                        {h.fromTradingView ? <span className="text-text-secondary">TradingView</span> : <span className="text-signal-bear">other source</span>}
                      </td>
                      <td className={`px-3 py-1 whitespace-nowrap font-semibold ${h.decision.startsWith("rejected") ? "text-signal-bear" : "text-text-primary"}`}>
                        {h.decision}
                      </td>
                      <td className="px-3 py-1 text-text-secondary">{h.reason ?? `${h.trend ?? ""} ${h.event ?? ""}`.trim()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}
