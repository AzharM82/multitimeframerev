import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JournalFill, JournalNote } from "../types.js";
import { getJournalTrades, getJournalNotes, saveJournalNote, getJournalSummary } from "../services/api.js";

/**
 * Trade Journal — Robinhood fills, one dictation box per (day, symbol), and a
 * rolling 10-point lessons list.
 *
 * Two deliberate shapes:
 *
 *  - Fills roll up BY UNDERLYING, not per row. 95% of the flow is options, so a
 *    day is 30+ legs of "AAPL  260807C00315000". Journalling against 30 legs is
 *    the friction that produced 3 notes in 501 days in the old standalone app;
 *    journalling against "AAPL, −$3,536" is a question you can answer.
 *
 *  - The note box is a plain textarea on purpose. OpenWhispr (Ctrl+Shift+R)
 *    types into whatever is focused, so this IS the voice-note box — no
 *    recording UI needed. Dictation runs long, so it autosaves on blur and
 *    warns before you navigate away with an unsaved draft.
 *
 * Trades and the lessons list are pushed up by tools/journal-sync on the dev
 * machine. Reading this tab and saving a note never touch that job — the
 * browser talks straight to the portal — so journalling still works when that
 * machine is off; only new fills and a refreshed summary wait for it.
 */

const EPOCH = "2026-08-03";

const money = (n: number) =>
  `${n < 0 ? "−" : "+"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (n: number) => (n > 0 ? "text-signal-bull" : n < 0 ? "text-signal-bear" : "text-text-secondary");

/** "AAPL  260807C00315000" → "Aug 07 '26 $315 C" */
function legLabel(ticker: string): string {
  const m = String(ticker).trim().match(/^([A-Z.\-]+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return String(ticker).trim();
  const [, , yy, mm, dd, cp, strike8] = m;
  const strike = Number(strike8) / 1000;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(mm) - 1] ?? mm;
  const s = Number.isInteger(strike) ? String(strike) : strike.toFixed(2);
  return `${month} ${dd} '${yy} $${s} ${cp}`;
}

interface Group {
  date: string;
  underlying: string;
  fills: JournalFill[];
  realized: number | null;
  closes: number;
  contracts: number;
}

function groupFills(fills: JournalFill[]): Map<string, Group[]> {
  const byKey = new Map<string, Group>();
  for (const f of fills) {
    const key = `${f.tradeDate}|${f.underlying}`;
    let g = byKey.get(key);
    if (!g) {
      g = { date: f.tradeDate, underlying: f.underlying, fills: [], realized: null, closes: 0, contracts: 0 };
      byKey.set(key, g);
    }
    g.fills.push(f);
    g.contracts += f.quantity ?? 0;
    if (f.side === "SELL") g.closes += 1;
    if (f.realizedPnl !== null && f.realizedPnl !== undefined) {
      g.realized = (g.realized ?? 0) + f.realizedPnl;
    }
  }
  const byDate = new Map<string, Group[]>();
  for (const g of byKey.values()) {
    g.fills.sort((a, b) => String(a.filledAt).localeCompare(String(b.filledAt)));
    const list = byDate.get(g.date) ?? [];
    list.push(g);
    byDate.set(g.date, list);
  }
  // Biggest absolute P&L first — the trades worth writing about lead.
  for (const list of byDate.values()) {
    list.sort((a, b) => Math.abs(b.realized ?? 0) - Math.abs(a.realized ?? 0));
  }
  return byDate;
}

// ─── One symbol's card: performance, legs, and the dictation box ─────────────

function SymbolCard({
  group,
  note,
  onSaved,
  onDirtyChange,
}: {
  group: Group;
  note: JournalNote | undefined;
  onSaved: (n: JournalNote) => void;
  onDirtyChange: (key: string, dirty: boolean) => void;
}) {
  const saved = note?.text ?? "";
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const dirty = draft !== saved;
  const key = `${group.date}|${group.underlying}`;

  useEffect(() => setDraft(saved), [saved, group.date, group.underlying]);

  // The page owns the close-the-window guard, so it has to know this card is
  // mid-dictation. Clearing on unmount stops a card that scrolled out of the
  // day from holding the guard open forever.
  useEffect(() => {
    onDirtyChange(key, dirty);
    return () => onDirtyChange(key, false);
  }, [key, dirty, onDirtyChange]);

  /**
   * `live` is the textarea's own value, passed by onBlur.
   *
   * Blur must NOT trust `draft`: if focus leaves in the same tick as the last
   * keystroke, the handler React attached is the previous render's closure,
   * where draft is still the old text and `dirty` is false — the save returns
   * early and the note is lost with no error. That is precisely the dictation
   * path (OpenWhispr types into the field, then you click away), which is the
   * one this box exists for. Reading the element's value sidesteps it.
   */
  const save = useCallback(async (live?: string) => {
    const text = live ?? draft;
    if (text === saved || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await saveJournalNote(group.date, group.underlying, text);
      setDraft(text);
      onSaved({ date: group.date, underlying: group.underlying, text, updatedAt: r.updatedAt });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, saved, saving, group.date, group.underlying, onSaved]);

  const buys = group.fills.filter((f) => f.side === "BUY").length;

  return (
    <div className="bg-bg-card border border-border rounded">
      <div className="flex items-baseline gap-3 px-3 py-2 border-b border-border">
        <span className="font-bold text-sm">{group.underlying}</span>
        {group.realized === null ? (
          <span className="text-[11px] text-text-secondary">open — no realized P&amp;L yet</span>
        ) : (
          <span className={`tabular-nums font-semibold text-sm ${tone(group.realized)}`}>{money(group.realized)}</span>
        )}
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {group.fills.length} fills · {buys} buy / {group.closes} sell · {group.contracts} qty
        </span>
        <span className="flex-1" />
        {saved && !dirty && <span className="text-[10px] text-signal-bull">noted</span>}
        {dirty && <span className="text-[10px] text-signal-bear">unsaved</span>}
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary"
        >
          {open ? "hide legs" : `legs (${group.fills.length})`}
        </button>
      </div>

      {open && (
        <div className="px-3 py-1.5 border-b border-border overflow-x-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {group.fills.map((f) => (
                <tr key={f.id} className="border-b border-border/40 last:border-b-0">
                  <td className="py-0.5 pr-3 whitespace-nowrap">{legLabel(f.ticker)}</td>
                  <td className={`py-0.5 pr-3 font-semibold ${f.side === "BUY" ? "text-text-secondary" : "text-text-primary"}`}>
                    {f.side}
                  </td>
                  <td className="py-0.5 pr-3 tabular-nums text-right">{f.quantity}</td>
                  <td className="py-0.5 pr-3 tabular-nums text-right">@ {f.price}</td>
                  <td className={`py-0.5 tabular-nums text-right ${f.realizedPnl ? tone(f.realizedPnl) : "text-dim"}`}>
                    {f.realizedPnl === null || f.realizedPnl === undefined ? "—" : money(f.realizedPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-3 py-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => save(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={`What happened on ${group.underlying}? (Ctrl+Shift+R to dictate)`}
          className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs leading-relaxed
                     focus:outline-none focus:border-text-secondary resize-y"
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => save()}
            disabled={!dirty || saving}
            className="px-2.5 py-1 rounded-full text-[10px] font-semibold border border-border
                       text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {err && <span className="text-[10px] text-signal-bear">{err}</span>}
          {note?.updatedAt && !dirty && (
            <span className="text-[10px] text-dim">
              saved {new Date(note.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function JournalPage() {
  const [fills, setFills] = useState<JournalFill[]>([]);
  const [notes, setNotes] = useState<Record<string, JournalNote>>({});
  const [points, setPoints] = useState<string[]>([]);
  const [summaryAt, setSummaryAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const dirtyKeys = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, n, s] = await Promise.all([getJournalTrades(EPOCH), getJournalNotes(EPOCH), getJournalSummary()]);
        if (cancelled) return;
        setFills(t.fills);
        const map: Record<string, JournalNote> = {};
        for (const x of n.notes) map[`${x.date}|${x.underlying}`] = x;
        setNotes(map);
        setPoints(s.points);
        setSummaryAt(s.generatedAt);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const byDate = useMemo(() => groupFills(fills), [fills]);
  const dates = useMemo(() => [...byDate.keys()].sort().reverse(), [byDate]);
  const active = date && byDate.has(date) ? date : dates[0] ?? null;
  const groups = active ? byDate.get(active) ?? [] : [];

  const dayPnl = groups.reduce((a, g) => a + (g.realized ?? 0), 0);
  const noted = groups.filter((g) => notes[`${g.date}|${g.underlying}`]?.text).length;

  // A long dictation is expensive to lose; blur-save covers tab switches, this
  // covers closing the window mid-sentence.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirtyKeys.current.size > 0) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  const onDirtyChange = useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
  }, []);

  const onSaved = useCallback((n: JournalNote) => {
    setNotes((prev) => ({ ...prev, [`${n.date}|${n.underlying}`]: n }));
  }, []);

  if (loading) return <div className="text-center py-16 text-sm text-text-secondary">Loading journal …</div>;
  if (error) return <div className="text-center py-16 text-sm text-signal-bear">{error}</div>;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-bold">Trade Journal</h1>
        <p className="text-xs text-text-secondary">
          Robinhood fills from {EPOCH}. One note per symbol per day — press <strong>Ctrl+Shift+R</strong> to dictate.
        </p>
      </div>

      {dates.length === 0 ? (
        <div className="bg-bg-card border border-border rounded px-3 py-6 text-sm text-text-secondary">
          No trades yet. Run the sync on this machine:{" "}
          <code className="text-[11px]">node tools/journal-sync/sync.mjs</code>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            {dates.map((d) => {
              const gs = byDate.get(d) ?? [];
              const p = gs.reduce((a, g) => a + (g.realized ?? 0), 0);
              return (
                <button
                  key={d}
                  onClick={() => setDate(d)}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                    d === active
                      ? "bg-text-primary text-bg-primary border-text-primary"
                      : "border-border text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  <span className={`ml-1.5 tabular-nums ${d === active ? "" : tone(p)}`}>{money(p)}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-baseline gap-3 text-[10px] uppercase tracking-wider text-text-secondary">
            <span>{groups.length} symbols</span>
            <span className="text-dim">·</span>
            <span>
              day P&amp;L <span className={`tabular-nums font-semibold ${tone(dayPnl)}`}>{money(dayPnl)}</span>
            </span>
            <span className="text-dim">·</span>
            <span>{noted}/{groups.length} noted</span>
          </div>

          <div className="space-y-2">
            {groups.map((g) => (
              <SymbolCard
                key={`${g.date}|${g.underlying}`}
                group={g}
                note={notes[`${g.date}|${g.underlying}`]}
                onSaved={onSaved}
                onDirtyChange={onDirtyChange}
              />
            ))}
          </div>
        </>
      )}

      {/* Rolling lessons — capped at 10, rebuilt on the dev machine by the sync job. */}
      <div className="bg-bg-card border border-border rounded">
        <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">
          What I've learned
          <span className="font-normal normal-case text-text-secondary">
            {" "}· top 10, consolidated — never an 11th
          </span>
        </div>
        {points.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-secondary">
            Nothing yet. Write a few notes above, then the next sync builds the list from them.
          </div>
        ) : (
          <>
            <ol className="px-3 py-2 space-y-1.5">
              {points.map((p, i) => (
                <li key={i} className="text-xs leading-relaxed flex gap-2">
                  <span className="text-dim tabular-nums shrink-0">{String(i + 1).padStart(2, "0")}</span>
                  <span>{p}</span>
                </li>
              ))}
            </ol>
            {summaryAt && (
              <div className="px-3 py-1.5 text-[10px] text-dim border-t border-border">
                rebuilt {new Date(summaryAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
