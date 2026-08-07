/**
 * Sector Desk daily history — a 30-day trail of each sector's strength, so the
 * desk can show a per-sector "oscillator" (signed strength over time) and you
 * can review how rotation evolved.
 *
 * Storage: Azure Table `SectorDeskHistory`, PartitionKey = sector key, RowKey =
 * ET date (YYYY-MM-DD). That layout makes one sector's whole series a single
 * partition read. The sector-desk cron upserts all 11 rows on every run, so a
 * day's row converges to its closing-session value. Trimmed to 30 days by the
 * shared purge job.
 */

import { upsert, listByPartition, TABLES } from "../tables.js";
import { SECTORS } from "./deskSources.js";
import type { MmSectorDeskData } from "./sectorDesk.js";

function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Upsert today's snapshot (11 sector rows). Never throws — history is best-effort. */
export async function writeSectorDeskSnapshot(data: MmSectorDeskData): Promise<void> {
  const date = etToday();
  try {
    await Promise.all(
      data.groups.map((g) =>
        upsert(TABLES.SECTOR_DESK_HISTORY, g.key, date, {
          sector: g.sector,
          etf: g.etf,
          gss: g.gss,
          fromOpen: g.etfFromOpen,
          dayChg: g.etfMove,
          volParticipation: g.volParticipation,
          breadth: g.breadth,
          tradeable: g.tradeable,
          bias: g.bias ?? "",
        }),
      ),
    );
  } catch (err) {
    console.warn(`[sector-desk-history] snapshot write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface HistPoint {
  date: string;
  gss: number; // signed strength −100..+100
  fromOpen: number; // ETF change-from-open %
  tradeable: boolean;
  bias: string; // "LONG" | "SHORT" | ""
}

export interface SectorHistory {
  key: string;
  sector: string;
  etf: string;
  points: HistPoint[]; // ascending by date, ≤ `days`
}

interface Row {
  rowKey: string;
  gss?: number | string;
  fromOpen?: number | string;
  tradeable?: boolean;
  bias?: string;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Per-sector daily series, newest `days` days, ascending by date. */
export async function readSectorDeskHistory(days: number): Promise<SectorHistory[]> {
  const out: SectorHistory[] = [];
  for (const def of SECTORS) {
    let rows: Row[] = [];
    try {
      rows = await listByPartition<Row>(TABLES.SECTOR_DESK_HISTORY, def.key);
    } catch {
      rows = [];
    }
    const points: HistPoint[] = rows
      .map((r) => ({
        date: r.rowKey,
        gss: num(r.gss),
        fromOpen: num(r.fromOpen),
        tradeable: !!r.tradeable,
        bias: String(r.bias ?? ""),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-days);
    out.push({ key: def.key, sector: def.label, etf: def.etf, points });
  }
  return out;
}
