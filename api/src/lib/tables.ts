/**
 * Generic Azure Table client factory + entity helpers.
 *
 * cosmos.ts is hardcoded to the "Watchlists" table. This module gives us a
 * singleton client per table name with auto-create-if-missing semantics.
 */

import { TableClient, TableServiceClient, odata } from "@azure/data-tables";

const clients = new Map<string, TableClient>();
const ensured = new Set<string>();

function getServiceClient(): TableServiceClient {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  return TableServiceClient.fromConnectionString(connStr);
}

export function getClient(tableName: string): TableClient {
  const cached = clients.get(tableName);
  if (cached) return cached;
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  const client = TableClient.fromConnectionString(connStr, tableName);
  clients.set(tableName, client);
  return client;
}

export async function ensureTable(tableName: string): Promise<void> {
  if (ensured.has(tableName)) return;
  try {
    await getServiceClient().createTable(tableName);
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode !== 409 && e.code !== "TableAlreadyExists") {
      throw err;
    }
  }
  ensured.add(tableName);
}

export async function upsert<T extends object>(
  tableName: string,
  partitionKey: string,
  rowKey: string,
  data: T,
): Promise<void> {
  await ensureTable(tableName);
  await getClient(tableName).upsertEntity({
    partitionKey,
    rowKey,
    ...data,
  });
}

export async function getOne<T>(
  tableName: string,
  partitionKey: string,
  rowKey: string,
): Promise<T | null> {
  await ensureTable(tableName);
  try {
    const entity = await getClient(tableName).getEntity(partitionKey, rowKey);
    return entity as unknown as T;
  } catch {
    return null;
  }
}

export async function listByPartition<T>(
  tableName: string,
  partitionKey: string,
): Promise<T[]> {
  await ensureTable(tableName);
  const out: T[] = [];
  const iter = getClient(tableName).listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${partitionKey}` },
  });
  for await (const e of iter) out.push(e as unknown as T);
  return out;
}

export async function listAll<T>(tableName: string): Promise<T[]> {
  await ensureTable(tableName);
  const out: T[] = [];
  const iter = getClient(tableName).listEntities();
  for await (const e of iter) out.push(e as unknown as T);
  return out;
}

export async function remove(
  tableName: string,
  partitionKey: string,
  rowKey: string,
): Promise<void> {
  await ensureTable(tableName);
  try {
    await getClient(tableName).deleteEntity(partitionKey, rowKey);
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 404) throw err;
  }
}

export const TABLES = {
  AVWAP_RESULTS: "AvwapResults",
  BULL_LIST: "BullList",
  PAPER_TRADES: "PaperTrades",
  ALERT_LOG: "AlertLog",
} as const;
