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
