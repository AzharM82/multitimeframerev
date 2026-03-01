import { CosmosClient, type Container } from "@azure/cosmos";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let container: Container | null = null;

function getContainer(): Container {
  if (container) return container;

  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) {
    throw new Error("COSMOS_CONNECTION_STRING not set — using file fallback");
  }

  const client = new CosmosClient(connStr);
  const database = client.database("ReversalScanner");
  container = database.container("watchlists");
  return container;
}

export interface WatchlistDoc {
  id: string;
  tickers: string[];
  updatedAt: string;
}

const DEFAULT_ID = "default";

// ─── File-based fallback when Cosmos is not configured ──────────────────────

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

function isCosmosConfigured(): boolean {
  return !!process.env.COSMOS_CONNECTION_STRING;
}

export async function getWatchlist(): Promise<WatchlistDoc> {
  if (!isCosmosConfigured()) return loadFileWatchlist();

  try {
    const { resource } = await getContainer().item(DEFAULT_ID, DEFAULT_ID).read<WatchlistDoc>();
    if (!resource) {
      return { id: DEFAULT_ID, tickers: [], updatedAt: new Date().toISOString() };
    }
    return resource;
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

  if (!isCosmosConfigured()) {
    saveFileWatchlist(doc);
    return doc;
  }

  await getContainer().items.upsert(doc);
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
