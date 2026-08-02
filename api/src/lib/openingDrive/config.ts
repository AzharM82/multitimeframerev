/**
 * Opening Drive — all thresholds in one place (spec §CANDIDATE CRITERIA / §TRIGGER).
 *
 * Every value is env-overridable so the strategy can be tuned without a code
 * change; the resolved config is logged with each scan/alert so a research pass
 * can re-score history under a different hypothesis (same discipline as BigDog).
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export type NoCatalystAction = "demote" | "block" | "allow";
export type GateMode = "strict" | "gap";

export interface OpeningDriveConfig {
  // Phase 2 — gate
  gateMode: GateMode;

  // Phase 1 — candidate criteria
  minMarketCap: number;
  minPrice: number;
  minAvgDollarVol: number; // liquidity floor so IEX bars track consolidated
  minGapPct: number;
  minPmVolume: number;
  minPmVolRatio: number; // fraction of 30d avg daily vol
  minAtrRatio: number; // atr_14d / prior_close
  minRoomOverheadPct: number;

  // Catalyst
  noCatalystAction: NoCatalystAction;
  catalystFreshHours: number; // window is really "since yesterday 16:00 ET"; kept for docs
  catalystKeywordsHigh: string[];
  catalystKeywordsMedium: string[];
  catalystKeywordsLow: string[];

  // Phase 2 — trigger
  minRvol: number;
  maxWickRatio: number; // upper_wick <= maxWickRatio * body
  barMinutes: number; // 2-min bars
  engineStartEt: string; // "09:30"
  engineStopEt: string; // trigger window end
  monitorStopEt: string; // post-trigger monitor end

  // Sizing
  accountRiskDollars: number;
}

export function loadConfig(): OpeningDriveConfig {
  return {
    // Default "gap": open above prior close qualifies; clearing yesterday's high
    // is a strength tier, not a hard gate (user decision, 2026-07-22).
    gateMode: envStr("OD_GATE_MODE", "gap") as GateMode,
    minMarketCap: envNum("OD_MIN_MARKET_CAP", 500_000_000),
    // $50 floor: liquid, higher-priced momentum leaders (user decision 2026-08-01).
    minPrice: envNum("OD_MIN_PRICE", 50.0),
    // Liquidity floor so free-IEX bars track consolidated closely.
    minAvgDollarVol: envNum("OD_MIN_AVG_DOLLAR_VOL", 20_000_000),
    minGapPct: envNum("OD_MIN_GAP_PCT", 2.0),
    minPmVolume: envNum("OD_MIN_PM_VOLUME", 500_000),
    minPmVolRatio: envNum("OD_MIN_PM_VOL_RATIO", 0.05),
    minAtrRatio: envNum("OD_MIN_ATR_RATIO", 0.02),
    minRoomOverheadPct: envNum("OD_MIN_ROOM_OVERHEAD_PCT", 3.0),

    noCatalystAction: envStr("OD_NO_CATALYST_ACTION", "demote") as NoCatalystAction,
    catalystFreshHours: envNum("OD_CATALYST_FRESH_HOURS", 24),
    catalystKeywordsHigh: envStr(
      "OD_CATALYST_KW_HIGH",
      "earnings,beats,raises guidance,guidance,fda,approval,8-k,contract,acquisition,merger,upgrade to buy",
    ).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    catalystKeywordsMedium: envStr(
      "OD_CATALYST_KW_MEDIUM",
      "price target,pt raised,initiates,analyst,reiterates,partnership",
    ).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    catalystKeywordsLow: envStr(
      "OD_CATALYST_KW_LOW",
      "opinion,why,could,3 stocks,things to know,motley",
    ).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

    minRvol: envNum("OD_MIN_RVOL", 3.0),
    maxWickRatio: envNum("OD_MAX_WICK_RATIO", 0.5),
    barMinutes: envNum("OD_BAR_MINUTES", 2),
    engineStartEt: envStr("OD_ENGINE_START_ET", "09:30"),
    engineStopEt: envStr("OD_ENGINE_STOP_ET", "10:15"),
    monitorStopEt: envStr("OD_MONITOR_STOP_ET", "10:30"),

    accountRiskDollars: envNum("OD_ACCOUNT_RISK_DOLLARS", 500),
  };
}
