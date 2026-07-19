import { gzipSync, gunzipSync } from "zlib";
import { upsert, getOne, TABLES } from "../tables.js";

/**
 * Panel cache for the Metrics tab.
 *
 * Metrics panels are expensive — Key Metrics alone fires dozens of sequential
 * FinViz requests with deliberate pacing — far too slow to compute inside a
 * browser request. So panels are computed by a cron-driven timer and served
 * from here.
 *
 * Follows the same gzip → base64 → p0..pN chunking the ATR Matrix uses, because
 * Azure Table caps each string property at 64KB (32K UTF-16 chars) and these
 * payloads exceed it.
 *
 * IMPORTANT behavioural note inherited from MarketMetrics: reads NEVER compute
 * on demand. A cold cache returns 503 rather than blocking the caller for
 * minutes. That is why the timer matters — without it every panel is empty.
 */

const CHUNK_CHARS = 30000;

export type PanelName =
  | "key-metrics"
  | "breadth"
  | "screeners"
  | "movers";

export const PANELS: PanelName[] = [
  "key-metrics",
  "breadth",
  "screeners",
  "movers",
];

interface PanelRow {
  generated: string;
  parts: number;
  [key: string]: unknown;
}

/** Store a panel payload under partition "latest", row = panel name. */
export async function putPanel(panel: PanelName, payload: unknown): Promise<void> {
  const b64 = gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64");
  const chunks: Record<string, string> = {};
  let parts = 0;
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) {
    chunks[`p${parts}`] = b64.slice(i, i + CHUNK_CHARS);
    parts += 1;
  }
  await upsert(TABLES.MM_PANELS, "latest", panel, {
    generated: new Date().toISOString(),
    parts,
    ...chunks,
  });
}

export interface PanelResult<T> {
  data: T;
  generated: string;
}

/** Read a panel payload. Returns null when it has never been computed. */
export async function getPanel<T>(panel: PanelName): Promise<PanelResult<T> | null> {
  const row = await getOne<PanelRow>(TABLES.MM_PANELS, "latest", panel);
  if (!row) return null;

  let b64 = "";
  for (let i = 0; i < (row.parts ?? 0); i += 1) {
    b64 += (row[`p${i}`] as string) ?? "";
  }
  if (!b64) return null;

  return {
    data: JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf-8")) as T,
    generated: row.generated,
  };
}
