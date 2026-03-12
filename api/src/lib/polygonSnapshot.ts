const API_KEY = process.env.POLYGON_API_KEY ?? "";
const BATCH_SIZE = 250;
const DELAY_MS = 200;
const MAX_RETRIES = 3;

export interface SnapshotTicker {
  ticker: string;
  todaysChangePerc: number;
  todaysChange: number;
  updated: number;
  day: { o: number; h: number; l: number; c: number; v: number; vw: number };
  min: { av: number; t: number; n: number; o: number; h: number; l: number; c: number; v: number; vw: number };
  prevDay: { o: number; h: number; l: number; c: number; v: number; vw: number };
  lastTrade: { p: number; s: number; t: number };
  lastQuote: { P: number; S: number; p: number; s: number; t: number };
}

interface SnapshotResponse {
  status: string;
  tickers: SnapshotTicker[];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchSnapshotBatch(tickers: string[]): Promise<SnapshotTicker[]> {
  const tickerList = tickers.join(",");
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}&apiKey=${API_KEY}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url);

    if (res.status === 429) {
      const backoff = Math.pow(2, attempt) * 1000;
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Polygon snapshot API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as SnapshotResponse;
    return data.tickers ?? [];
  }

  throw new Error("Polygon snapshot API: max retries exceeded (429)");
}

export async function fetchAllSnapshots(tickers: string[]): Promise<Map<string, SnapshotTicker>> {
  const result = new Map<string, SnapshotTicker>();
  const batches: string[][] = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    batches.push(tickers.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    const snapshots = await fetchSnapshotBatch(batches[i]);
    for (const snap of snapshots) {
      result.set(snap.ticker, snap);
    }
    // Delay between batches (skip after last)
    if (i < batches.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  return result;
}
