/**
 * SPY Conviction shadow ledger — the ONE fixed rule, as pure functions.
 *
 * Every accepted BUY_CALL / BUY_PUT is scored against this rule after the close
 * and the result is kept forever, so the operator can come back in two weeks
 * and read a number nobody has re-fitted in the meantime.
 *
 *   Contract  SPY at-the-money strike (SPY at the signal, rounded), expiring the
 *             Friday of that week. A Friday signal is same-day expiry.
 *   Entry     After the 2-minute bar containing the alert closes, wait up to
 *             WAIT_MIN minutes for SPY's 1-minute range to touch the 2-minute
 *             9 EMA. Fill at the midpoint of the option's 1-minute bar for that
 *             minute. No touch inside the window = NO_TOUCH, no trade.
 *   Exit      +TARGET_PCT on the bar high, −STOP_PCT on the bar low with the
 *             stop checked FIRST, otherwise the last bar of the session.
 *             Never overnight.
 *   Money     One contract. Gross $ and a flat round-trip commission line.
 *
 * Two deliberate honesty choices, both of which make the numbers a little
 * worse than the research scripts that found this rule:
 *   • the EMA a minute "sees" is the EMA of the LAST COMPLETED 2-minute bar,
 *     never the bar still forming — that is all a trader can see either;
 *   • the target may not fill inside the entry minute (we do not know whether
 *     the high printed before or after our fill), but the stop may.
 *
 * Nothing here talks to a broker, a table, or the network. `simulate` takes
 * bars in and gives a row out, which is what makes it testable.
 */

export interface MinuteBar {
  /** RFC3339 bar-open time, UTC. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}

export const RULE = {
  /** Wait for the pullback this many minutes after the alert bar closes. */
  WAIT_MIN: 10,
  /** 2-minute EMA length on SPY. */
  EMA_LEN: 9,
  TARGET_PCT: 20,
  STOP_PCT: 9,
  /** Informational: would these targets have filled before the stop? */
  ALT_TARGETS: [10, 15] as const,
  /**
   * Per-contract round-trip commission. ZERO on purpose: the operator would
   * run this on Tradier Pro ($10/month flat), where SPY options carry no
   * per-contract commission. On the Lite tier ($0.35 a side) the backfill's
   * ~325 contracts would have cost $227.50 — more than the subscription — so
   * the flat fee is the realistic case and is not modelled per trade.
   * Exchange/regulatory pass-through fees (a few cents a contract) are also
   * excluded at the operator's request. Applied at read time like the account
   * size, so changing it re-prices history.
   */
  COMMISSION_RT: 0,
  /**
   * The account the operator would fund. Sizing is "as many contracts as the
   * account buys at the entry", not compounded, so every trade is judged
   * against the same $2,000 and the percentages stay comparable day to day.
   * Applied at READ time from the stored entry price, so changing it never
   * rewrites history.
   */
  ACCOUNT_USD: 2000,
  /** Human-readable, rendered on the tab. Keep in step with the constants. */
  label: "2-min 9 EMA pullback within 10 min · +20% target · −9% stop · else close",
} as const;

export type ShadowStatus = "FILLED" | "NO_TOUCH" | "NO_DATA";
export type ExitReason = "TP" | "SL" | "EOD" | "";

export interface ShadowSignal {
  /** ET trading day, YYYY-MM-DD. */
  day: string;
  side: "CALL" | "PUT";
  /** Indicator bar time, ET "YYYY-MM-DD HH:MM:SS" — the 10-min bar CLOSE. */
  barTime: string;
  /** SPY at the signal, for the strike. */
  spy: number;
}

export interface ShadowResult {
  status: ShadowStatus;
  contract: string;
  /** UTC HH:MM of the minute SPY touched the EMA, "" if none. */
  touchMinuteUtc: string;
  /** Minutes waited after the alert bar closed, −1 if no touch. */
  waitedMin: number;
  emaAtTouch: number | null;
  spyAtTouch: number | null;
  entry: number | null;
  exit: number | null;
  exitReason: ExitReason;
  retPct: number | null;
  grossUsd: number | null;
  netUsd: number | null;
  heldMin: number | null;
  /** Highest % gain seen after entry, before any exit — context for the review. */
  mfePct: number | null;
  tp10Hit: boolean;
  tp15Hit: boolean;
  /** Why NO_DATA, when it is. */
  note: string;
}

// ─── Time helpers ───────────────────────────────────────────────────────────

/** ET wall-clock → UTC epoch ms, DST-aware, no library. */
export function etToUtcMs(day: string, hhmm: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  // First guess: treat the wall time as UTC, then correct by the ET offset
  // Intl reports for that instant. One correction is enough away from the
  // transition hour, and the session never touches 2 AM.
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetMin = etOffsetMinutes(new Date(guess));
  return guess - offsetMin * 60_000;
}

function etOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - at.getTime()) / 60_000); // −240 in EDT, −300 in EST
}

const minuteKey = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const barMs = (b: MinuteBar) => Date.parse(b.t);

/** Friday of the ISO week containing `day` (Sat/Sun roll forward, harmless). */
export function fridayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Mon=0
  dt.setUTCDate(dt.getUTCDate() + ((4 - dow) + 7) % 7);
  return dt.toISOString().slice(0, 10);
}

export function contractSymbol(day: string, side: "CALL" | "PUT", spy: number): string {
  const exp = fridayOf(day).replace(/-/g, "").slice(2);
  const strike = Math.round(spy);
  return `SPY${exp}${side === "CALL" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`;
}

// ─── EMA ────────────────────────────────────────────────────────────────────

/**
 * EMA of 2-minute closes, seeded with the first close (the session is short
 * and the seed washes out in a few bars). Returns one point per bar, keyed by
 * the bar's CLOSE time, because that is the first instant the value exists.
 */
export function ema2(bars2: MinuteBar[], len = RULE.EMA_LEN): { closeMs: number; ema: number }[] {
  const k = 2 / (len + 1);
  let e: number | null = null;
  const out: { closeMs: number; ema: number }[] = [];
  for (const b of bars2) {
    e = e === null ? b.c : b.c * k + e * (1 - k);
    out.push({ closeMs: barMs(b) + 2 * 60_000, ema: e });
  }
  return out;
}

/** The EMA visible at minute `ms`: the last bar that had CLOSED by then. */
function emaVisible(points: { closeMs: number; ema: number }[], ms: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.closeMs <= ms) v = p.ema;
    else break;
  }
  return v;
}

// ─── The rule ───────────────────────────────────────────────────────────────

export function simulate(
  sig: ShadowSignal,
  spy1: MinuteBar[],
  spy2: MinuteBar[],
  opt1: MinuteBar[],
): ShadowResult {
  const contract = contractSymbol(sig.day, sig.side, sig.spy);
  const base: ShadowResult = {
    status: "NO_DATA", contract, touchMinuteUtc: "", waitedMin: -1,
    emaAtTouch: null, spyAtTouch: null, entry: null, exit: null, exitReason: "",
    retPct: null, grossUsd: null, netUsd: null, heldMin: null, mfePct: null,
    tp10Hit: false, tp15Hit: false, note: "",
  };
  if (!spy1.length || !spy2.length) return { ...base, note: "no SPY bars" };
  if (!opt1.length) return { ...base, note: `no option bars for ${contract}` };

  // The alert bar is the 2-minute bar that OPENS at the 10-minute close.
  const alertHhmm = sig.barTime.slice(11, 16);
  const alertOpenMs = etToUtcMs(sig.day, alertHhmm);
  const windowStart = alertOpenMs + 2 * 60_000;

  const spyByMin = new Map(spy1.map((b) => [minuteKey(barMs(b)), b]));
  const optByMin = new Map(opt1.map((b) => [minuteKey(barMs(b)), b]));
  const emaPts = ema2(spy2);

  // 1. Wait for the touch.
  let touchMs = -1; let emaAtTouch: number | null = null; let spyAtTouch: number | null = null;
  for (let i = 0; i < RULE.WAIT_MIN; i++) {
    const ms = windowStart + i * 60_000;
    const s = spyByMin.get(minuteKey(ms));
    const e = emaVisible(emaPts, ms);
    if (!s || e === null) continue;
    if (s.l <= e && e <= s.h) { touchMs = ms; emaAtTouch = e; spyAtTouch = s.c; break; }
  }
  if (touchMs < 0) return { ...base, status: "NO_TOUCH", note: "" };

  // 2. Fill at that minute's option midpoint (next printed minute if that one is empty).
  let entryBar: MinuteBar | undefined;
  for (let i = 0; i < 3 && !entryBar; i++) entryBar = optByMin.get(minuteKey(touchMs + i * 60_000));
  if (!entryBar) {
    return { ...base, touchMinuteUtc: minuteKey(touchMs), waitedMin: Math.round((touchMs - windowStart) / 60_000),
      emaAtTouch, spyAtTouch, note: "option did not print in the touch minute" };
  }
  const entry = round2((entryBar.h + entryBar.l) / 2);
  const entryMs = barMs(entryBar);
  const target = entry * (1 + RULE.TARGET_PCT / 100);
  const stop = entry * (1 - RULE.STOP_PCT / 100);

  // 3. Walk forward. Stop first, target not inside the entry minute.
  let exit: number | null = null; let reason: ExitReason = ""; let exitMs = entryMs;
  let mfe = 0; let tp10 = false; let tp15 = false; let stopped = false;
  const after = opt1.filter((b) => barMs(b) >= entryMs);
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (b.l <= stop) { exit = round2(stop); reason = "SL"; exitMs = barMs(b); stopped = true; break; }
    if (i > 0) {
      mfe = Math.max(mfe, (b.h / entry - 1) * 100);
      if (!tp10 && b.h >= entry * 1.10) tp10 = true;
      if (!tp15 && b.h >= entry * 1.15) tp15 = true;
      if (b.h >= target) { exit = round2(target); reason = "TP"; exitMs = barMs(b); break; }
    }
  }
  if (exit === null) {
    const last = after[after.length - 1];
    exit = last.c; reason = "EOD"; exitMs = barMs(last);
  }
  void stopped;

  const retPct = round2((exit / entry - 1) * 100);
  const gross = round2((exit - entry) * 100);
  return {
    status: "FILLED", contract,
    touchMinuteUtc: minuteKey(touchMs),
    waitedMin: Math.round((touchMs - windowStart) / 60_000),
    emaAtTouch: round2(emaAtTouch!), spyAtTouch,
    entry, exit, exitReason: reason, retPct,
    grossUsd: gross, netUsd: round2(gross - RULE.COMMISSION_RT),
    heldMin: Math.round((exitMs - entryMs) / 60_000) + 1,
    mfePct: round2(mfe), tp10Hit: tp10, tp15Hit: tp15, note: "",
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Account sizing ─────────────────────────────────────────────────────────

export interface AccountFill {
  contracts: number;
  /** Premium paid, contracts × entry × 100. */
  costUsd: number;
  grossUsd: number;
  commissionUsd: number;
  netUsd: number;
  /** Net as a percentage of the ACCOUNT, not of the premium. */
  retPct: number;
}

/** Size one filled trade for a fixed account. Zero contracts if the premium is
 *  larger than the account (it never is for ATM SPY weeklies at $2,000). */
export function sizeForAccount(entry: number, grossPerContract: number, account: number = RULE.ACCOUNT_USD): AccountFill {
  const contracts = entry > 0 ? Math.floor(account / (entry * 100)) : 0;
  const gross = round2(grossPerContract * contracts);
  const commission = round2(RULE.COMMISSION_RT * contracts);
  const net = round2(gross - commission);
  return {
    contracts, costUsd: round2(contracts * entry * 100), grossUsd: gross, commissionUsd: commission, netUsd: net,
    retPct: account > 0 ? round2((net / account) * 100) : 0,
  };
}

// ─── Aggregates for the tab ─────────────────────────────────────────────────

export interface LedgerRow {
  day: string;
  side: "CALL" | "PUT";
  status: ShadowStatus;
  entry: number | null;
  grossUsd: number | null;
  netUsd: number | null;
  exitReason: ExitReason;
}

export interface AccountSummary {
  sizeUsd: number;
  grossUsd: number;
  commissionUsd: number;
  netUsd: number;
  /** Net over the whole ledger as % of the account. */
  retPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  avgContracts: number | null;
  bestTradeUsd: number | null;
  worstTradeUsd: number | null;
  bySide: Record<"CALL" | "PUT", number>;
  /** Cumulative net $ on the account after each trading day, oldest first. */
  equity: { day: string; netUsd: number; pct: number }[];
}

export interface LedgerSummary {
  days: number;
  signals: number;
  filled: number;
  noTouch: number;
  noData: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossUsd: number;
  commissionUsd: number;
  netUsd: number;
  maxDrawdownUsd: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  bySide: Record<"CALL" | "PUT", { filled: number; wins: number; netUsd: number }>;
  byExit: Record<"TP" | "SL" | "EOD", number>;
  /** Cumulative net $ after each trading day, oldest first. */
  equity: { day: string; netUsd: number }[];
  /** The same ledger sized for RULE.ACCOUNT_USD. */
  account: AccountSummary;
}

function summarizeAccount(sorted: LedgerRow[], account: number): AccountSummary {
  const filled = sorted.filter((r) => r.status === "FILLED" && r.entry !== null && r.grossUsd !== null);
  const fills = filled.map((r) => ({ r, f: sizeForAccount(r.entry!, r.grossUsd!, account) }));
  const byDay = new Map<string, number>();
  for (const { r, f } of fills) byDay.set(r.day, (byDay.get(r.day) ?? 0) + f.netUsd);
  const equity: { day: string; netUsd: number; pct: number }[] = [];
  let cum = 0; let peak = 0; let dd = 0;
  for (const day of [...new Set(sorted.map((r) => r.day))]) {
    cum += byDay.get(day) ?? 0; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak);
    equity.push({ day, netUsd: round2(cum), pct: round2((cum / account) * 100) });
  }
  const nets = fills.map(({ f }) => f.netUsd);
  const net = round2(sum(nets));
  return {
    sizeUsd: account,
    grossUsd: round2(sum(fills.map(({ f }) => f.grossUsd))),
    commissionUsd: round2(sum(fills.map(({ f }) => f.commissionUsd))),
    netUsd: net,
    retPct: round2((net / account) * 100),
    maxDrawdownUsd: round2(dd),
    maxDrawdownPct: round2((dd / account) * 100),
    avgContracts: fills.length ? round2(sum(fills.map(({ f }) => f.contracts)) / fills.length) : null,
    bestTradeUsd: nets.length ? Math.max(...nets) : null,
    worstTradeUsd: nets.length ? Math.min(...nets) : null,
    bySide: {
      CALL: round2(sum(fills.filter(({ r }) => r.side === "CALL").map(({ f }) => f.netUsd))),
      PUT: round2(sum(fills.filter(({ r }) => r.side === "PUT").map(({ f }) => f.netUsd))),
    },
    equity,
  };
}

export function summarize(rows: LedgerRow[], account: number = RULE.ACCOUNT_USD): LedgerSummary {
  // Net is re-derived from gross with the CURRENT commission constant, never
  // read from the stored row: a stored net would freeze whichever commission
  // was in force on the day it was scored, and the account view would then
  // disagree with the per-contract footnote.
  const sorted = [...rows]
    .map((r) => (r.status === "FILLED" && r.grossUsd !== null ? { ...r, netUsd: round2(r.grossUsd - RULE.COMMISSION_RT) } : r))
    .sort((a, b) => a.day.localeCompare(b.day));
  const filled = sorted.filter((r) => r.status === "FILLED" && r.netUsd !== null && r.grossUsd !== null);
  const wins = filled.filter((r) => (r.grossUsd ?? 0) > 0);
  const losses = filled.filter((r) => (r.grossUsd ?? 0) <= 0);
  const gross = sum(filled.map((r) => r.grossUsd ?? 0));
  const net = sum(filled.map((r) => r.netUsd ?? 0));

  const byDay = new Map<string, number>();
  for (const r of filled) byDay.set(r.day, (byDay.get(r.day) ?? 0) + (r.netUsd ?? 0));
  const equity: { day: string; netUsd: number }[] = [];
  let cum = 0; let peak = 0; let dd = 0;
  for (const day of [...new Set(sorted.map((r) => r.day))]) {
    cum += byDay.get(day) ?? 0; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak);
    equity.push({ day, netUsd: round2(cum) });
  }
  const side = (s: "CALL" | "PUT") => {
    const f = filled.filter((r) => r.side === s);
    return { filled: f.length, wins: f.filter((r) => (r.grossUsd ?? 0) > 0).length, netUsd: round2(sum(f.map((r) => r.netUsd ?? 0))) };
  };
  return {
    days: byDay.size || new Set(sorted.map((r) => r.day)).size,
    signals: sorted.length,
    filled: filled.length,
    noTouch: sorted.filter((r) => r.status === "NO_TOUCH").length,
    noData: sorted.filter((r) => r.status === "NO_DATA").length,
    wins: wins.length, losses: losses.length,
    winRate: filled.length ? Math.round((100 * wins.length) / filled.length) : null,
    grossUsd: round2(gross),
    commissionUsd: round2(filled.length * RULE.COMMISSION_RT),
    netUsd: round2(net),
    maxDrawdownUsd: round2(dd),
    avgWinUsd: wins.length ? round2(sum(wins.map((r) => r.grossUsd ?? 0)) / wins.length) : null,
    avgLossUsd: losses.length ? round2(sum(losses.map((r) => r.grossUsd ?? 0)) / losses.length) : null,
    bySide: { CALL: side("CALL"), PUT: side("PUT") },
    byExit: {
      TP: filled.filter((r) => r.exitReason === "TP").length,
      SL: filled.filter((r) => r.exitReason === "SL").length,
      EOD: filled.filter((r) => r.exitReason === "EOD").length,
    },
    equity,
    account: summarizeAccount(sorted, account),
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
