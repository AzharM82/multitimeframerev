/**
 * Date helpers. All user-facing "today" stamps use the Pacific calendar date so
 * an evening-PT run doesn't roll into the next UTC day (the bug that showed a
 * June-4 close as June-5). Note: this is for *display/partition* stamps only —
 * bar-timestamp → date conversions and Polygon query ranges must stay literal.
 */

/** Pacific (America/Los_Angeles) calendar date as YYYY-MM-DD. */
export function pacificDateKey(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/**
 * Eastern (America/New_York) calendar date as YYYY-MM-DD.
 *
 * Use this — NOT pacificDateKey — whenever the answer is measured against a
 * MARKET date. Option expirations are ET dates, so days-to-expiry has to be
 * counted from the ET calendar: between 9pm and midnight Pacific the Eastern
 * day has already rolled, and a Pacific-derived DTE would read one day too
 * high for that whole window, silently sliding expiries in and out of the
 * 28–60 day filter every evening.
 */
export function easternDateKey(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
