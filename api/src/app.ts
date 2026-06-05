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
// dayTradeTimer disabled — the TOS Finviz scanner is the single source for
// Day Trade alerts (POSTs to /api/scanner-alert below). Keeping this
// timer registered created duplicate alerts on WhatsApp + portal for the
// same signal. File kept in tree in case we want to re-enable.
// import "./functions/dayTradeTimer.js";
import "./functions/dayTradeAlerts.js";
import "./functions/dayTradePerformance.js";
import "./functions/scannerAlert.js";
import "./functions/paperTrades.js";

// ATR Matrix (swing extension scanner)
import "./functions/atrEodTimer.js";
import "./functions/atrScan.js";

// Market breadth / health gauge
import "./functions/breadth.js";
