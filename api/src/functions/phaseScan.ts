import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { getWatchlist } from "../lib/cosmos.js";
import { fetchPhaseTimeframes } from "../lib/polygon.js";
import { getPhaseSignal, computePhaseScore, type PhaseStockResult, type PhaseTimeframe } from "../lib/phaseOscillator.js";

const PHASE_LIST = "phase";
const BATCH_SIZE = 10;

async function phaseScanHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    // Accept tickers from query param or from phase watchlist
    let tickers: string[];
    const queryTickers = req.query.get("tickers");
    if (queryTickers) {
      tickers = queryTickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    } else {
      const wl = await getWatchlist(PHASE_LIST);
      tickers = wl.tickers.map((e) => e.ticker);
    }

    if (tickers.length === 0) {
      return {
        jsonBody: {
          stocks: [],
          scannedAt: new Date().toISOString(),
          message: "No tickers to scan",
        },
      };
    }

    const results: PhaseStockResult[] = [];
    const errors: Array<{ ticker: string; error: string }> = [];

    for (let b = 0; b < tickers.length; b += BATCH_SIZE) {
      const batch = tickers.slice(b, b + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (ticker) => {
          const data = await fetchPhaseTimeframes(ticker);

          const signals: Record<PhaseTimeframe, ReturnType<typeof getPhaseSignal>> = {
            "1W": getPhaseSignal(data.weekly, "1W"),
            "1D": getPhaseSignal(data.daily, "1D"),
            "60m": getPhaseSignal(data.m60, "60m"),
            "30m": getPhaseSignal(data.m30, "30m"),
          };

          const price = data.daily.length > 0
            ? data.daily[data.daily.length - 1].close
            : 0;

          const score = computePhaseScore(signals);
          return { ticker, price, score, signals } as PhaseStockResult;
        }),
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : "Unknown error";
          ctx.log(`Error phase-scanning ${batch[i]}: ${errMsg}`);
          errors.push({ ticker: batch[i], error: errMsg });
        }
      }

      // Delay between batches (skip after last)
      if (b + BATCH_SIZE < tickers.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Sort by score: most oversold (highest +) first, then most overbought (lowest -)
    results.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.ticker.localeCompare(b.ticker);
    });

    return {
      jsonBody: {
        stocks: results,
        errors: errors.length > 0 ? errors : undefined,
        scannedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("phaseScan", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "phase-scan",
  handler: phaseScanHandler,
});
