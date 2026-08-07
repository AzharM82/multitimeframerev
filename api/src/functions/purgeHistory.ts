import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { listAll, remove, TABLES } from "../lib/tables.js";

/**
 * POST /api/purge-history  (x-timer-secret)
 *
 * Trims the date-keyed history tables to a 30-day window — Azure Tables have no
 * native TTL, so a small daily job does it. Fired by mtfrev-cron after the close.
 *
 *  - SectorDeskHistory: PartitionKey = sector, RowKey = ET date → delete rows
 *    whose RowKey (date) is older than the cutoff.
 *  - OpeningDrive:      PartitionKey = ET date, RowKey = ticker → delete rows
 *    whose PartitionKey (date) is older than the cutoff.
 *
 * Both tables are small (≤ a few hundred rows), so a full scan + filter is fine.
 */

const RETENTION_DAYS = 30;

function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function minusDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

interface Row {
  partitionKey: string;
  rowKey: string;
}

async function purgeHistory(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const cutoff = minusDays(etToday(), RETENTION_DAYS); // keep dates >= cutoff
  const deleted: Record<string, number> = {};

  try {
    // SectorDeskHistory — date is the RowKey.
    let n = 0;
    for (const r of await listAll<Row>(TABLES.SECTOR_DESK_HISTORY)) {
      if (r.rowKey < cutoff) { await remove(TABLES.SECTOR_DESK_HISTORY, r.partitionKey, r.rowKey); n += 1; }
    }
    deleted[TABLES.SECTOR_DESK_HISTORY] = n;
  } catch (err) {
    ctx.error(`purge SectorDeskHistory failed: ${err instanceof Error ? err.message : String(err)}`);
    deleted[TABLES.SECTOR_DESK_HISTORY] = -1;
  }

  try {
    // OpeningDrive — date is the PartitionKey.
    let n = 0;
    for (const r of await listAll<Row>(TABLES.OPENING_DRIVE)) {
      if (r.partitionKey < cutoff) { await remove(TABLES.OPENING_DRIVE, r.partitionKey, r.rowKey); n += 1; }
    }
    deleted[TABLES.OPENING_DRIVE] = n;
  } catch (err) {
    ctx.error(`purge OpeningDrive failed: ${err instanceof Error ? err.message : String(err)}`);
    deleted[TABLES.OPENING_DRIVE] = -1;
  }

  return { status: 200, jsonBody: { status: "ok", cutoff, retentionDays: RETENTION_DAYS, deleted } };
}

app.http("purgeHistory", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "purge-history",
  handler: purgeHistory,
});
