import { CAPITULATION_TICKERS } from "./capitulationTickers.js";
import { fetchAllSnapshots, type SnapshotTicker } from "./polygonSnapshot.js";

export type CapitulationTier = "CRITICAL" | "HIGH" | "WATCH";

export interface CapitulationSignal {
  ticker: string;
  price: number;
  prevClose: number;
  open: number;
  gapPct: number;
  recoveryPct: number;
  rvol: number;
  todayVolume: number;
  prevDayVolume: number;
  tier: CapitulationTier;
  timeWeight: number;
  timeWindow: string;
}

export interface CapitulationScanResponse {
  signals: CapitulationSignal[];
  scannedAt: string;
  marketOpen: boolean;
  totalScanned: number;
  scanDurationMs: number;
}

function getCurrentPrice(snap: SnapshotTicker): number {
  // Price fallback chain: lastTrade.p → min.c → day.c
  if (snap.lastTrade?.p && snap.lastTrade.p > 0) return snap.lastTrade.p;
  if (snap.min?.c && snap.min.c > 0) return snap.min.c;
  if (snap.day?.c && snap.day.c > 0) return snap.day.c;
  return 0;
}

function getTimeWeight(): { weight: number; window: string } {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();

  if (mins >= 570 && mins < 600) return { weight: 2.0, window: "9:30-10:00" };
  if (mins >= 600 && mins < 630) return { weight: 1.5, window: "10:00-10:30" };
  if (mins >= 630 && mins < 690) return { weight: 1.2, window: "10:30-11:30" };
  if (mins >= 690 && mins < 840) return { weight: 1.0, window: "11:30-14:00" };
  if (mins >= 840 && mins <= 960) return { weight: 0.8, window: "14:00-16:00" };
  return { weight: 0, window: "closed" };
}

function computeRVOL(snap: SnapshotTicker): number {
  const todayVol = snap.day?.v ?? 0;
  const prevVol = snap.prevDay?.v ?? 0;
  if (prevVol <= 0 || todayVol <= 0) return 0;

  // Estimate minutes elapsed since market open (9:30 ET)
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const minutesElapsed = Math.max(1, mins - 570); // 570 = 9:30
  const projectionFactor = 390 / minutesElapsed; // 390 = full trading day minutes

  return (todayVol / prevVol) * projectionFactor;
}

function classifyTier(gapPct: number, recoveryPct: number, rvol: number): CapitulationTier | null {
  // Check CRITICAL first, then HIGH, then WATCH
  if (gapPct <= -8 && recoveryPct >= 1.0 && rvol >= 3.0) return "CRITICAL";
  if (gapPct <= -5 && recoveryPct >= 0.5 && rvol >= 2.0) return "HIGH";
  if (gapPct <= -3 && recoveryPct > 0 && rvol >= 1.5) return "WATCH";
  return null;
}

function isMarketOpen(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins <= 960;
}

const TIER_PRIORITY: Record<CapitulationTier, number> = {
  CRITICAL: 0,
  HIGH: 1,
  WATCH: 2,
};

export async function runCapitulationScan(): Promise<CapitulationScanResponse> {
  const startTime = Date.now();
  const snapshots = await fetchAllSnapshots(CAPITULATION_TICKERS);
  const { weight: timeWeight, window: timeWindow } = getTimeWeight();
  const signals: CapitulationSignal[] = [];

  for (const ticker of CAPITULATION_TICKERS) {
    const snap = snapshots.get(ticker);
    if (!snap) continue;

    const prevClose = snap.prevDay?.c ?? 0;
    const open = snap.day?.o ?? 0;
    const price = getCurrentPrice(snap);

    if (prevClose <= 0 || open <= 0 || price <= 0) continue;

    const gapPct = ((open - prevClose) / prevClose) * 100;
    const recoveryPct = ((price - open) / open) * 100;
    const rvol = computeRVOL(snap);

    const tier = classifyTier(gapPct, recoveryPct, rvol);
    if (!tier) continue;

    signals.push({
      ticker,
      price,
      prevClose,
      open,
      gapPct,
      recoveryPct,
      rvol,
      todayVolume: snap.day?.v ?? 0,
      prevDayVolume: snap.prevDay?.v ?? 0,
      tier,
      timeWeight,
      timeWindow,
    });
  }

  // Sort: tier priority (CRITICAL > HIGH > WATCH), then gap magnitude (most negative first)
  signals.sort((a, b) => {
    const tierDiff = TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.gapPct - b.gapPct; // more negative gap = higher priority
  });

  return {
    signals,
    scannedAt: new Date().toISOString(),
    marketOpen: isMarketOpen(),
    totalScanned: CAPITULATION_TICKERS.length,
    scanDurationMs: Date.now() - startTime,
  };
}
