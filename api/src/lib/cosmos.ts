import { TableClient } from "@azure/data-tables";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let tableClient: TableClient | null = null;

function getTableClient(): TableClient {
  if (tableClient) return tableClient;

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  }

  tableClient = TableClient.fromConnectionString(connStr, "Watchlists");
  return tableClient;
}

export interface WatchlistDoc {
  id: string;
  tickers: string[];
  updatedAt: string;
}

const DEFAULT_ID = "default";

// ─── File-based fallback when Table Storage is not configured ────────────────

const WATCHLIST_FILE = join(__dirname, "..", "..", "watchlist.json");

function loadFileWatchlist(): WatchlistDoc {
  try {
    if (existsSync(WATCHLIST_FILE)) {
      const raw = readFileSync(WATCHLIST_FILE, "utf-8");
      return JSON.parse(raw) as WatchlistDoc;
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { id: DEFAULT_ID, tickers: [], updatedAt: new Date().toISOString() };
}

function saveFileWatchlist(doc: WatchlistDoc): void {
  writeFileSync(WATCHLIST_FILE, JSON.stringify(doc, null, 2), "utf-8");
}

function isStorageConfigured(): boolean {
  return !!process.env.AZURE_STORAGE_CONNECTION_STRING;
}

export async function getWatchlist(): Promise<WatchlistDoc> {
  if (!isStorageConfigured()) return loadFileWatchlist();

  try {
    const entity = await getTableClient().getEntity<{ tickers: string; updatedAt: string }>(
      DEFAULT_ID,
      DEFAULT_ID,
    );
    return {
      id: DEFAULT_ID,
      tickers: JSON.parse(entity.tickers) as string[],
      updatedAt: entity.updatedAt,
    };
  } catch {
    return { id: DEFAULT_ID, tickers: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveWatchlist(tickers: string[]): Promise<WatchlistDoc> {
  const doc: WatchlistDoc = {
    id: DEFAULT_ID,
    tickers: [...new Set(tickers.map((t) => t.toUpperCase().trim()).filter(Boolean))],
    updatedAt: new Date().toISOString(),
  };

  if (!isStorageConfigured()) {
    saveFileWatchlist(doc);
    return doc;
  }

  await getTableClient().upsertEntity({
    partitionKey: DEFAULT_ID,
    rowKey: DEFAULT_ID,
    tickers: JSON.stringify(doc.tickers),
    updatedAt: doc.updatedAt,
  });
  return doc;
}

export async function addTickers(newTickers: string[]): Promise<WatchlistDoc> {
  const current = await getWatchlist();
  const merged = [...new Set([...current.tickers, ...newTickers.map((t) => t.toUpperCase().trim())])];
  return saveWatchlist(merged);
}

export async function removeTicker(ticker: string): Promise<WatchlistDoc> {
  const current = await getWatchlist();
  const filtered = current.tickers.filter((t) => t !== ticker.toUpperCase().trim());
  return saveWatchlist(filtered);
}
