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

// Rotation — sector/industry rotation (ported from the sector-rotation app)
import "./functions/rotQuotes.js";
import "./functions/rotPerformance.js";
import "./functions/rotWeeklyHistory.js";

// Portal authentication — SWA rolesSource allowlist (Google sign-in).
// Invoked by the SWA platform, not the browser; must stay anonymous.
import "./functions/getRoles.js";
