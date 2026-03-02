import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { getWatchlist } from "../lib/cosmos.js";
import { fetchAllTimeframes, fetchTickerInfo } from "../lib/polygon.js";
import { scanStock, type StockScanResult } from "../lib/indicators.js";
import { getCachedScan, setCachedScan } from "../lib/cache.js";
import { startScan, updateScanTicker, completeTicker, finishScan } from "../lib/scanStatus.js";

const BULL_CATEGORIES = new Set([
  "Squeeze Fired", "Bull Close", "Power of 3 - Bull",
  "21 SMA Range - Bull", "Signal Daily - Bull", "Universe",
]);
const BEAR_CATEGORIES = new Set([
  "Bear Close", "Power of 3 - Bear", "21 SMA Range - Bear", "Signal Daily - Bear",
]);

// Scoring: Weekly ±5, Daily ±3, 65m ±2, 10m 0, Category ±5
const TF_WEIGHTS: Record<string, number> = { "1W": 5, "1D": 3, "65m": 2, "10m": 0 };

function computeScore(stock: StockScanResult): number {
  let score = 0;
  for (const [tf, weight] of Object.entries(TF_WEIGHTS)) {
    const dir = stock.signals[tf as keyof typeof stock.signals]?.direction;
    if (dir === "bullish") score += weight;
    else if (dir === "bearish") score -= weight;
  }
  if (BULL_CATEGORIES.has(stock.category)) score += 5;
  else if (BEAR_CATEGORIES.has(stock.category)) score -= 5;
  return score;
}

function isMarketOpen(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const hours = et.getHours();
  const minutes = et.getMinutes();
  const timeMinutes = hours * 60 + minutes;
  return timeMinutes >= 570 && timeMinutes <= 960;
}

async function scanHandler(_req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const cached = getCachedScan();
    if (cached) {
      return {
        jsonBody: {
          stocks: cached,
          scannedAt: new Date().toISOString(),
          marketOpen: isMarketOpen(),
          fromCache: true,
        },
      };
    }

    const wl = await getWatchlist();
    if (wl.tickers.length === 0) {
      return {
        jsonBody: {
          stocks: [],
          scannedAt: new Date().toISOString(),
          marketOpen: isMarketOpen(),
          message: "No tickers in watchlist",
        },
      };
    }

    // Build category lookup from watchlist entries
    const categoryMap = new Map<string, string>();
    for (const entry of wl.tickers) {
      categoryMap.set(entry.ticker, entry.category);
    }

    const tickers = wl.tickers.map((e) => e.ticker);
    startScan(tickers.length);

    const results: StockScanResult[] = [];
    const errors: Array<{ ticker: string; error: string }> = [];

    // Process in batches of 10 to avoid overwhelming Polygon API
    const BATCH_SIZE = 10;
    const allResults: PromiseSettledResult<StockScanResult>[] = [];

    for (let b = 0; b < tickers.length; b += BATCH_SIZE) {
      const batch = tickers.slice(b, b + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (ticker) => {
          updateScanTicker(ticker);
          const [data, info] = await Promise.all([fetchAllTimeframes(ticker), fetchTickerInfo(ticker)]);
          completeTicker(ticker);
          return scanStock(ticker, data.weekly, data.daily, data.m65, data.m10, info.industry);
        }),
      );
      allResults.push(...batchResults);
      // Small delay between batches (skip after last batch)
      if (b + BATCH_SIZE < tickers.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i];
      if (result.status === "fulfilled") {
        result.value.category = categoryMap.get(tickers[i]) ?? "";
        result.value.score = computeScore(result.value);
        results.push(result.value);
      } else {
        const errMsg = result.reason instanceof Error ? result.reason.message : "Unknown error";
        ctx.log(`Error scanning ${tickers[i]}: ${errMsg}`);
        errors.push({ ticker: tickers[i], error: errMsg });
      }
    }

    // Sort by score descending (highest conviction first)
    results.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.ticker.localeCompare(b.ticker);
    });

    setCachedScan(results);
    finishScan(results.length, errors.length);

    return {
      jsonBody: {
        stocks: results,
        errors: errors.length > 0 ? errors : undefined,
        scannedAt: new Date().toISOString(),
        marketOpen: isMarketOpen(),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    finishScan(0, 1);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("scan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "scan",
  handler: scanHandler,
});
