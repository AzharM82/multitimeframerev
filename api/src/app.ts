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

// v2 — revamp (5 sections)
import "./functions/avwapEodTimer.js";
import "./functions/avwapResults.js";
import "./functions/bullEmailTimer.js";
import "./functions/bullList.js";
import "./functions/bullMonitorTimer.js";
// Day Trades website section retired 2026-06-16 (superseded by DTSWAI, real
// Alpaca paper). The day-trade read/perf/timer functions are removed; we KEEP
// scannerAlert so the local Finviz scanner's POST still 200s and its WhatsApp
// alerts (enqueued locally, independent of this POST) keep flowing.
import "./functions/scannerAlert.js";
import "./functions/paperTrades.js";

// ATR Matrix (swing extension scanner)
import "./functions/atrEodTimer.js";
import "./functions/atrScan.js";
import "./functions/atrLookup.js";
import "./functions/atrIntraday.js";

// Market breadth / health gauge
import "./functions/breadth.js";
