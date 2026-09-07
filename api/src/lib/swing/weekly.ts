/**
 * Daily → weekly bars for the Weinstein lens.
 *
 * Weeks end on Friday (ET calendar week, Monday–Friday). The current week is
 * included even if it is not finished yet — that is what a weekly chart shows
 * on a Wednesday — and flagged `complete: false` so the reader can say so.
 * Polygon daily bars carry a UTC-midnight-ish timestamp for the ET session
 * date; the date is taken in ET so a bar never lands in the wrong week.
 */

import type { Candle } from "../indicators.js";

export interface WeeklyBar {
  /** ISO date of the Friday that ends the week. */
  weekEnd: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Trading days folded into this week. */
  days: number;
  /** False for the week in progress (fewer than the days a full week had, or ends after the last bar). */
  complete: boolean;
}

// One formatter, reused: toLocaleDateString builds a new Intl formatter per
// call, which made this fold ~110 ms per ticker (31 s across the universe).
const ET_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDate = (ms: number) => ET_FMT.format(new Date(ms));

/** The Friday (ISO date) of the week containing an ISO date. */
export function weekEndFor(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  dt.setUTCDate(dt.getUTCDate() + (4 - dow));
  return dt.toISOString().slice(0, 10);
}

export function toWeekly(daily: Candle[]): WeeklyBar[] {
  const out: WeeklyBar[] = [];
  let cur: WeeklyBar | null = null;
  for (const b of daily) {
    const we = weekEndFor(etDate(b.timestamp));
    if (!cur || cur.weekEnd !== we) {
      if (cur) out.push(cur);
      cur = { weekEnd: we, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, days: 1, complete: true };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.days += 1;
    }
  }
  if (cur) out.push(cur);
  // The last week is complete only if its last bar IS the Friday (or the data
  // ends on the week's Friday). Holidays make 4-day weeks complete; we cannot
  // tell a Thursday holiday from a Thursday scan, so the Friday test is the rule.
  if (out.length) {
    const last = out[out.length - 1];
    const lastBarDate = etDate(daily[daily.length - 1].timestamp);
    last.complete = lastBarDate === last.weekEnd;
  }
  return out;
}
