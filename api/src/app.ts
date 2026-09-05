// Entry point — import all function registrations
// Legacy (v1) — still imported during cutover; will be removed in cleanup PR
import "./functions/health.js";
import "./functions/watchlist.js";
import "./functions/scan.js";
import "./functions/scanStatus.js";
import "./functions/phaseScan.js";
import "./functions/phaseWatchlist.js";
import "./functions/capitulationScan.js";
import "./functions/capitulationTimer.js";
import "./functions/weeklyCapitulationScan.js";
import "./functions/weeklyCapitulationTimer.js";
import "./functions/screenerScan.js";

// Day Trades website section retired 2026-06-16 (superseded by DTSWAI, real
// Alpaca paper). The day-trade read/perf/timer functions are removed; we KEEP
// scannerAlert so the local Finviz scanner's POST still 200s and its WhatsApp
// alerts (enqueued locally, independent of this POST) keep flowing.
import "./functions/scannerAlert.js";

// BigDog Trades — intraday OCR alert ingestion (POST) + read (GET) for the tab
import "./functions/avwapEarnings.js";
import "./functions/bigdogAlert.js";
import "./functions/bigdogAlerts.js";

// ATR Matrix (swing extension scanner)
import "./functions/atrEodTimer.js";
import "./functions/atrScan.js";
import "./functions/atrLookup.js";
import "./functions/atrIntraday.js";

// Market breadth / health gauge
import "./functions/breadth.js";

// Catalyst Value Eval (CVE = Magnitude × Speed)
import "./functions/cveScan.js";
import "./functions/cveTimer.js";

// Unusual Options Activity (read proxy for the UnusualOptions scanner's blob output)
import "./functions/uoaSignals.js";

// Metrics — MarketMetrics core panels (cron-warmed cache + read proxy)
import "./functions/mmPanel.js";
import "./functions/mmTimer.js";
import "./functions/sectorDeskHistory.js";
import "./functions/purgeHistory.js";

// Gate — "should I be trading today?" (ported from ShouldIBeTrading)
import "./functions/gateScore.js";

// Rotation — sector/industry rotation (ported from the sector-rotation app)
import "./functions/rotQuotes.js";
import "./functions/rotPerformance.js";
import "./functions/rotWeeklyHistory.js";

// TradingView chart analysis — desktop sidecar mailbox + result store.
// Scoring runs in tools/tv-sidecar on the trading desktop, not here.
import "./functions/tvRequest.js";
import "./functions/tvAnalysis.js";
import "./functions/tvHistory.js";

// Opening Drive — SMB pre-market-high-break momentum pipeline.
// Replay is the historical validator (no live infra); scan/results/trigger
// wire Phase 1 (Azure) to Phase 2 (DESKTOP2 ToS scanner).
import "./functions/openingDriveReplay.js";
import "./functions/openingDriveScan.js";
import "./functions/openingDriveResults.js";
import "./functions/openingDriveTrigger.js";
import "./functions/openingDriveEngine.js";

// Trade Journal — Robinhood fills pushed up by tools/journal-sync on the
// trading desktop, dictated notes per (day, underlying), and the rolling
// 10-point lessons list. No broker or model credentials live in Azure.
import "./functions/journalTrades.js";
import "./functions/journalNotes.js";
import "./functions/journalSummary.js";

// SPY Conviction Score — TradingView alert sink for the six-leg 10-minute
// indicator. Registers /api/spy-conviction AND /api/tv-trend-webhook, the URL
// already configured in TradingView. Replaced the 5-min breadth-streak + Gate
// regime system on 2026-08-12: the indicator now emits the decision itself, so
// there is no regime lookup and no regime cron.
import "./functions/spyConviction.js";
import "./functions/spyShadow.js";

// Options Strategy Guide — plain-English credit-spread builder (Floor Bet =
// bull put, Ceiling Bet = bear call). The handlers only fetch and shape; all
// money math is pure in lib/spreadMath.ts so api/tools/spread-math-test.mjs can
// exercise it with no network. Chain comes from lib/optionsChain.ts, which
// dispatches on OPTIONS_FEED (finviz by default).
import "./functions/optionsExpiries.js";
import "./functions/optionsSpread.js";

// Portal authentication — SWA rolesSource allowlist (Google sign-in).
// Invoked by the SWA platform, not the browser; must stay anonymous.
import "./functions/getRoles.js";
