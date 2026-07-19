import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { KEY_TICKERS, SECTOR_TICKERS } from "../lib/gate/constants.js";
import { isMarketOpen } from "../lib/gate/marketHours.js";
import { fetchSnapshot, fetchDailyBars } from "../lib/gate/polygon.js";
import { fetchVixData, fetchTnxData, fetchDxyData, summarizeQuality } from "../lib/gate/macroQuotes.js";
import { fetchBreadthData } from "../lib/gate/finviz.js";
import { computeVixData, scoreVolatility } from "../lib/gate/volatility.js";
import { buildSectorData, scoreMomentum } from "../lib/gate/momentum.js";
import { computeTrendData, scoreTrend } from "../lib/gate/trend.js";
import { scoreBreadth } from "../lib/gate/breadth.js";
import { computeMacroData, scoreMacro } from "../lib/gate/macro.js";
import { computeExecutionData, scoreExecution } from "../lib/gate/executionWindow.js";
import { computeQualityScore, computeDecision } from "../lib/gate/composite.js";
import { computePosture } from "../lib/gate/posture.js";
import { generateSummary } from "../lib/gate/summary.js";
import type { MarketScoreResponse, TradingMode, BreadthData } from "../lib/gate/types.js";

/**
 * GET /api/gate-score?mode=day|swing
 *
 * The "should I be trading today?" gate — ported from the standalone
 * ShouldIBeTrading app. Scores five categories, applies the hard overrides,
 * and returns a YES / CAUTION / NO plus a recommended posture.
 *
 * Route is prefixed `gate-` deliberately: the source app's routes were
 * `market-score`, `health`, `trades` and `calibration`, and the last three
 * collide with names already registered in this portal. A duplicate
 * registration fails SILENTLY in Azure Functions, so prefixing is not cosmetic.
 *
 * Deliberate differences from the source:
 *   - VIX/TNX/DXY come from Polygon first and Yahoo only as fallback, with a
 *     sanity guard on both. The original hit an unofficial Yahoo endpoint that
 *     failed *soft* to 0, which read as a spuriously bullish low-VIX market.
 *   - The trade journal is not wired up (starting empty by choice), so posture
 *     runs without the calibration step-down. The logic is intact for later.
 */

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; body: MarketScoreResponse }>();

// Neutral breadth, used when FinViz is unavailable so one slow vendor cannot
// take the whole gate down. 50 = "half the market above the average".
const NEUTRAL_BREADTH: BreadthData = {
  above20d: 50,
  above50d: 50,
  above200d: 50,
  advDeclineRatio: 1,
  newHighs: 0,
  newLows: 0,
  nhNlRatio: 0.5,
};

async function gateScore(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const mode: TradingMode = req.query.get("mode") === "day" ? "day" : "swing";

    const hit = cache.get(mode);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return { jsonBody: hit.body, headers: { "Cache-Control": "no-store" } };
    }

    const [snapshots, vix, tnx, dxy, spyBars, qqqBars, breadthData] = await Promise.all([
      fetchSnapshot(KEY_TICKERS),
      fetchVixData(),
      fetchTnxData(),
      fetchDxyData(),
      fetchDailyBars("SPY", 250),
      fetchDailyBars("QQQ", 60),
      fetchBreadthData().catch((): BreadthData => {
        ctx.warn("gate-score: FinViz breadth unavailable — using neutral defaults");
        return NEUTRAL_BREADTH;
      }),
    ]);

    const vixData = computeVixData(vix.level, vix.change, vix.bars);
    const sectorData = buildSectorData(snapshots);
    const trendData = computeTrendData(spyBars, qqqBars);
    const spyCloses = spyBars.map((b) => b.c);
    const macroData = computeMacroData(tnx.bars, dxy.bars);
    if (tnx.price > 0) macroData.tnx.price = Math.round(tnx.price * 100) / 100;
    if (dxy.price > 0) macroData.dxy.price = Math.round(dxy.price * 100) / 100;
    const executionData = computeExecutionData(spyBars);

    const volatilityResult = scoreVolatility(vixData);
    const momentumResult = scoreMomentum(sectorData);
    const trendResult = scoreTrend(trendData, spyCloses, mode);
    const breadthResult = scoreBreadth(breadthData);
    const macroResult = scoreMacro(macroData, mode);
    const executionResult = scoreExecution(executionData);

    // Mode-dependent weights. Day trading leans on volatility and momentum;
    // swing leans on trend and breadth.
    if (mode === "day") {
      volatilityResult.weight = 0.3;
      momentumResult.weight = 0.3;
      trendResult.weight = 0.15;
      breadthResult.weight = 0.1;
      macroResult.weight = 0.15;
    } else {
      volatilityResult.weight = 0.2;
      momentumResult.weight = 0.2;
      trendResult.weight = 0.25;
      breadthResult.weight = 0.25;
      macroResult.weight = 0.1;
    }

    const rawQuality = computeQualityScore(
      volatilityResult.score,
      momentumResult.score,
      trendResult.score,
      breadthResult.score,
      macroResult.score,
      mode,
    );

    const { decision, qualityScore } = computeDecision(
      rawQuality,
      volatilityResult.score,
      vixData.level,
      trendData.spy.price,
      trendData.spy.ma200,
      breadthResult.score,
    );

    const tickerPrices: MarketScoreResponse["tickerPrices"] = [];
    for (const ticker of ["SPY", "QQQ", ...SECTOR_TICKERS]) {
      const snap = snapshots.get(ticker);
      if (snap) {
        tickerPrices.push({
          ticker,
          price: snap.day?.c ?? snap.prevDay?.c ?? 0,
          change: snap.todaysChange ?? 0,
          changePercent: snap.todaysChangePerc ?? 0,
        });
      }
    }
    tickerPrices.unshift(
      { ticker: "VIX", price: vixData.level, change: vixData.change, changePercent: vixData.change5d },
      { ticker: "TNX", price: macroData.tnx.price, change: 0, changePercent: macroData.tnx.change5d },
      { ticker: "DXY", price: macroData.dxy.price, change: 0, changePercent: macroData.dxy.change5d },
    );

    // Field names mirror the source exactly; posture reads trend values off the
    // SCORED result (trendResult.spy), not the raw trendData.
    const posture = computePosture({
      decision,
      executionScore: executionResult.score,
      breadthScore: breadthResult.score,
      spyPrice: trendResult.spy.price,
      ma50: trendResult.spy.ma50,
      regime: trendResult.spy.regime,
      rsi14: trendResult.spy.rsi14,
      pctPositive: momentumResult.pctPositive,
      vixLevel: vixData.level,
      vixPercentile: vixData.percentile,
    });

    const response: MarketScoreResponse = {
      decision,
      qualityScore,
      executionScore: executionResult.score,
      mode,
      summary: "",
      lastUpdated: new Date().toISOString(),
      marketOpen: isMarketOpen(),
      volatility: volatilityResult,
      momentum: momentumResult,
      trend: trendResult,
      breadth: breadthResult,
      macro: macroResult,
      execution: executionResult,
      posture,
      tickerPrices,
      // Rolls up the macro-feed sanity guards so a degraded VIX/TNX/DXY read is
      // surfaced rather than silently scoring as if the data were good.
      dataQuality: summarizeQuality([vix, tnx, dxy]),
    };
    response.summary = generateSummary(response);

    cache.set(mode, { at: Date.now(), body: response });
    return { jsonBody: response, headers: { "Cache-Control": "no-store" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`gate-score error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("gateScore", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "gate-score",
  handler: gateScore,
});
