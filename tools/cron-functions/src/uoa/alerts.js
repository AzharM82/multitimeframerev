/**
 * Which bursts are worth interrupting someone for, and what the message says.
 *
 * Pure functions, no I/O, because this decides what reaches a real phone every
 * two minutes for six and a half hours. Getting it wrong in the loud direction
 * is not a cosmetic bug: an alert channel that cries wolf stops being read, and
 * then the one that mattered is missed too.
 *
 * ── Why the alert bar is far above the tab's bar ──────────────────────────
 * The tab shows a burst at 15% of open interest or $500k committed. That is the
 * right level for something you are already looking at. It is the wrong level
 * for a phone: a uniform two-minute slice of a normal session already produced
 * four of them, and 195 polls a day at even one message each is an unreadable
 * stream. So alerting takes the same bursts and applies three more filters:
 *
 *   a much higher bar     — $1m committed in one window, or the window alone
 *                           trading twice the entire outstanding interest
 *   one line per name     — NVDA printing across five strikes is one story
 *   a cooldown and a cap  — the same name stays quiet for half an hour unless
 *                           it escalates sharply, and a wild day cannot send
 *                           more than a dozen messages
 *
 * And one message per poll, never one per burst. That rule is written down in
 * this repo because the AVWAP alerts learned it the expensive way: four levels
 * across a watchlist is ~190 events a day, which is fine as ten messages and
 * intolerable as one per ticker.
 */

"use strict";

const DEFAULT_ALERT = {
  /** Dollars committed in a single poll window. */
  minNotional: 1_000_000,
  /** ...or the window alone trades this multiple of all outstanding interest. */
  minOiShare: 2,
  /** Minutes a name stays quiet after alerting. */
  cooldownMin: 30,
  /** ...unless it comes back this many times larger. */
  escalationFactor: 3,
  /** Names per message. */
  maxLines: 6,
  /** Messages per session, across every name. */
  maxPerSession: 15,
};

/** Either test qualifies; neither has to carry the other. */
function qualifies(b, cfg = DEFAULT_ALERT) {
  return b.notional >= cfg.minNotional || b.oi_share >= cfg.minOiShare;
}

const fmtUsd = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
};

const fmtLots = (n) => Math.round(n).toLocaleString("en-US");

/**
 * Collapse this poll's qualifying bursts into at most one line per underlying.
 *
 * The line describes the single largest contract, but the money is the name's
 * whole total for the window — five strikes of the same expiry is one position
 * being built, and reporting only the biggest leg would understate it.
 */
function groupByUnderlying(bursts, cfg = DEFAULT_ALERT) {
  const by = new Map();
  for (const b of bursts) {
    if (!qualifies(b, cfg)) continue;
    const g = by.get(b.underlying);
    if (!g) {
      by.set(b.underlying, { underlying: b.underlying, top: b, notional: b.notional, lots: b.lots, legs: 1 });
      continue;
    }
    g.notional += b.notional;
    g.lots += b.lots;
    g.legs += 1;
    if (b.notional > g.top.notional) g.top = b;
  }
  return [...by.values()].sort((a, b) => b.notional - a.notional);
}

/**
 * Apply the cooldown, the escalation exception and the daily cap.
 *
 * `state.alerted` maps an underlying to { at, notional } from the last time it
 * was sent; `state.sent` is the session's message count.
 */
function selectAlerts(bursts, state, now, cfg = DEFAULT_ALERT) {
  const alerted = (state && state.alerted) || {};
  const sent = (state && state.sent) || 0;
  if (sent >= cfg.maxPerSession) return { lines: [], suppressed: "session_cap" };

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const g of groupByUnderlying(bursts, cfg)) {
    const prev = alerted[g.underlying];
    if (prev) {
      const minsSince = (nowMs - new Date(prev.at).getTime()) / 60_000;
      // Quiet unless the name has come back meaningfully bigger. A second
      // $1.1m print twenty minutes after a $1m one is the same story.
      if (minsSince < cfg.cooldownMin && g.notional < prev.notional * cfg.escalationFactor) continue;
    }
    out.push(g);
    if (out.length >= cfg.maxLines) break;
  }
  return { lines: out, suppressed: null };
}

/** The side lean, spelled out rather than abbreviated — this is read on a phone. */
function leanWord(side) {
  if (side === "bought") return "at ask";
  if (side === "sold") return "at bid";
  if (side === "mid") return "mid";
  return "";
}

/**
 * The message. Plain text, no markup — it goes to WhatsApp and Pushover, and
 * neither renders the same thing.
 */
function formatMessage(lines, meta = {}) {
  const head = lines.length === 1
    ? `Options flow: ${lines[0].underlying}`
    : `Options flow: ${lines.map((l) => l.underlying).join(", ")}`;

  const body = lines.map((g) => {
    const t = g.top;
    const lean = leanWord(t.side);
    const strike = t.strike % 1 === 0 ? t.strike : t.strike.toFixed(2);
    const share = t.oi_share >= 10 ? `${Math.round(t.oi_share)}x OI` : `${Math.round(t.oi_share * 100)}% of OI`;
    const legs = g.legs > 1 ? ` (+${g.legs - 1} more strike${g.legs > 2 ? "s" : ""}, ${fmtUsd(g.notional)} total)` : "";
    return `${g.underlying} ${strike}${t.type} ${t.expiry.slice(5)} (${t.dte}d)\n` +
      `  +${fmtLots(t.lots)} contracts, ${fmtUsd(t.notional)}, ${share}${lean ? `, ${lean}` : ""}${legs}`;
  }).join("\n");

  const tail =
    "\nOpen interest is yesterday's settlement — it does not move intraday. " +
    "Side is where the print sat in the spread, a lean not a fact." +
    (meta.windowSeconds ? ` Window ${Math.round(meta.windowSeconds / 60)}m.` : "");

  return { title: head, body: `${body}\n${tail}` };
}

/** The state to carry forward after sending. */
function markSent(state, lines, now) {
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const alerted = { ...((state && state.alerted) || {}) };
  for (const g of lines) alerted[g.underlying] = { at: stamp, notional: g.notional };
  return { alerted, sent: ((state && state.sent) || 0) + 1 };
}

module.exports = { DEFAULT_ALERT, qualifies, groupByUnderlying, selectAlerts, formatMessage, markSent };
