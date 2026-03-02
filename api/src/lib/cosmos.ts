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

export interface WatchlistEntry {
  ticker: string;
  category: string;
}

export interface WatchlistDoc {
  id: string;
  tickers: WatchlistEntry[];
  updatedAt: string;
}

const DEFAULT_ID = "default";

// ─── File-based fallback when Table Storage is not configured ────────────────

const WATCHLIST_FILE = join(__dirname, "..", "..", "watchlist.json");

/** Migrate old string[] format to WatchlistEntry[] */
function migrateTickers(raw: unknown[]): WatchlistEntry[] {
  return raw.map((item) =>
    typeof item === "string"
      ? { ticker: item, category: "" }
      : item as WatchlistEntry,
  );
}

function loadFileWatchlist(): WatchlistDoc {
  try {
    if (existsSync(WATCHLIST_FILE)) {
      const raw = readFileSync(WATCHLIST_FILE, "utf-8");
      const doc = JSON.parse(raw) as { id: string; tickers: unknown[]; updatedAt: string };
      return { id: doc.id, tickers: migrateTickers(doc.tickers), updatedAt: doc.updatedAt };
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
    const raw = JSON.parse(entity.tickers) as unknown[];
    return {
      id: DEFAULT_ID,
      tickers: migrateTickers(raw),
      updatedAt: entity.updatedAt,
    };
  } catch {
    return { id: DEFAULT_ID, tickers: [], updatedAt: new Date().toISOString() };
  }
}

/** Deduplicate by ticker (last category wins) */
function dedup(entries: WatchlistEntry[]): WatchlistEntry[] {
  const map = new Map<string, string>();
  for (const e of entries) {
    const t = e.ticker.toUpperCase().trim();
    if (t) map.set(t, e.category);
  }
  return Array.from(map, ([ticker, category]) => ({ ticker, category }));
}

export async function saveWatchlist(entries: WatchlistEntry[]): Promise<WatchlistDoc> {
  const doc: WatchlistDoc = {
    id: DEFAULT_ID,
    tickers: dedup(entries),
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

export async function addTickers(newEntries: WatchlistEntry[]): Promise<WatchlistDoc> {
  const current = await getWatchlist();
  // New entries overwrite existing categories for the same ticker
  const merged = [...current.tickers, ...newEntries];
  return saveWatchlist(merged);
}

export async function removeTicker(ticker: string): Promise<WatchlistDoc> {
  const current = await getWatchlist();
  const filtered = current.tickers.filter((e) => e.ticker !== ticker.toUpperCase().trim());
  return saveWatchlist(filtered);
}
