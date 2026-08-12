/**
 * Portal-wide time DISPLAY — always Pacific (America/Los_Angeles, i.e. PST/PDT).
 *
 * The user is in Pacific, so every time shown in the UI reads in PT. Market
 * LOGIC (the 9:30–16:00 ET session, cron schedules, `etMinutes`, ET trading-day
 * partitions) stays in Eastern server-side — only the display is Pacific. The
 * `America/Los_Angeles` identifier handles the PST↔PDT switch automatically, so
 * we label everything "PT" (correct year-round), matching the existing tabs.
 */

const PT_ZONE = "America/Los_Angeles";
export const PT_LABEL = "PT";

type TimeInput = Date | string | number;

function toDate(input: TimeInput): Date {
  return input instanceof Date ? input : new Date(input);
}

/** Clock time in Pacific, e.g. "6:34 AM". Pass opts to override (e.g. 24-hour). */
export function fmtTimePT(input: TimeInput, opts?: Intl.DateTimeFormatOptions): string {
  return toDate(input).toLocaleTimeString("en-US", {
    timeZone: PT_ZONE,
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  });
}

/** Date + clock in Pacific, e.g. "Aug 4, 1:28 PM". */
export function fmtDateTimePT(input: TimeInput, opts?: Intl.DateTimeFormatOptions): string {
  return toDate(input).toLocaleString("en-US", {
    timeZone: PT_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  });
}
