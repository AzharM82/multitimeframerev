/**
 * One-off cleanup: purge BullList trades created by the stale-U1 bug.
 *
 * The bug: bullEmailTimer anchored entry/SL/TP on the most recent U1 the
 * server ZigZag could find in 2 years of daily bars — with no freshness
 * check. Trades got "opened" at months-old prices, then instantly closed
 * at the live price (GOOG +27% "TP_HIT", PODD -50% "SL_HIT", etc).
 *
 * Bogus criteria:
 *   1. reversalBarTs more than MAX_SIGNAL_AGE_DAYS calendar days before
 *      addedAt (the alert fired today but the U1 is from months ago), OR
 *   2. (fallback for rows missing reversalBarTs) exit landed far beyond
 *      the level: SL_HIT below sl*(1-GAP) or TP_HIT above tp*(1+GAP).
 *
 * Scans both "closed" and "open" partitions — stale open rows would just
 * produce more bogus closes on the next monitor tick.
 *
 * Usage (from api/):
 *   node scripts/purgeStaleBullTrades.mjs          # dry run, prints what would be deleted
 *   node scripts/purgeStaleBullTrades.mjs --apply  # actually delete
 */

import { TableClient } from "@azure/data-tables";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAX_SIGNAL_AGE_DAYS = 6; // fresh U1 is 0-2 trading days old; 6 covers weekends/holidays
const GAP = 0.02;              // exit >2% beyond SL/TP = closed on a gap, not a real level touch

const apply = process.argv.includes("--apply");

const here = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(here, "..", "local.settings.json"), "utf8"));
const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? settings.Values.AZURE_STORAGE_CONNECTION_STRING;
if (!connStr) {
  console.error("AZURE_STORAGE_CONNECTION_STRING not found in env or local.settings.json");
  process.exit(1);
}

const client = TableClient.fromConnectionString(connStr, "BullList");

function isBogus(row) {
  if (row.reversalBarTs && row.addedAt) {
    const ageDays = (new Date(row.addedAt) - new Date(row.reversalBarTs)) / 86_400_000;
    if (ageDays > MAX_SIGNAL_AGE_DAYS) return `stale U1 (${String(row.reversalBarTs).slice(0, 10)}, ${ageDays.toFixed(0)}d before alert)`;
  } else if (row.exitPrice !== undefined) {
    if (row.exitReason === "SL_HIT" && row.exitPrice < row.sl * (1 - GAP)) {
      return `SL gap (exit ${row.exitPrice} << sl ${row.sl})`;
    }
    if (row.exitReason === "TP_HIT" && row.exitPrice > row.tp * (1 + GAP)) {
      return `TP gap (exit ${row.exitPrice} >> tp ${row.tp})`;
    }
  }
  return null;
}

let scanned = 0;
let flagged = 0;
const byPartition = { open: 0, closed: 0 };

for (const partition of ["open", "closed"]) {
  const iter = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${partition}'` },
  });
  for await (const row of iter) {
    scanned++;
    const reason = isBogus(row);
    if (!reason) continue;
    flagged++;
    byPartition[partition]++;
    console.log(`[${partition}] ${row.rowKey}  ${row.ticker}  entry=${row.entry}  ${row.exitReason ?? "OPEN"}  -> ${reason}`);
    if (apply) {
      await client.deleteEntity(partition, row.rowKey);
    }
  }
}

console.log(`\nScanned ${scanned} rows, flagged ${flagged} (open: ${byPartition.open}, closed: ${byPartition.closed})`);
console.log(apply ? "DELETED." : "Dry run — re-run with --apply to delete.");
