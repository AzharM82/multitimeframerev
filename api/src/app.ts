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
import "./functions/dayTradeTimer.js";
import "./functions/paperTrades.js";
