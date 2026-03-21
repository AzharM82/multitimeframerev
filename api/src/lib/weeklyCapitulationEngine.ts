import { getCapitulationTickers } from "./capitulationTickers.js";
import { fetchAllSnapshots, type SnapshotTicker } from "./polygonSnapshot.js";

export type WeeklyCapTier = "CRITICAL" | "HIGH" | "WATCH";

export interface WeeklyCapSignal {
  ticker: string;
  price: number;
  open: number;
  close5dAgo: number;
  dropPct: number;
  changeFromOpenPct: number;
  rvol: number;
  todayVolume: number;
  prevDayVolume: number;
  tier: WeeklyCapTier;
  capitulating: boolean; // true when changeFromOpenPct > 0 (bouncing)
}

export interface WeeklyCapScanResponse {
  signals: WeeklyCapSignal[];
  scannedAt: string;
  marketOpen: boolean;
  totalScanned: number;
  scanDurationMs: number;
}

const API_KEY = process.env.POLYGON_API_KEY ?? "";

function isMarketOpen(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins <= 960;
}

function getCurrentPrice(snap: SnapshotTicker): number {
  if (snap.lastTrade?.p && snap.lastTrade.p > 0) return snap.lastTrade.p;
  if (snap.min?.c && snap.min.c > 0) return snap.min.c;
  if (snap.day?.c && snap.day.c > 0) return snap.day.c;
  return 0;
}

function classifyWeeklyTier(dropPct: number): WeeklyCapTier | null {
  // dropPct is negative (e.g., -15%)
  if (dropPct <= -15) return "CRITICAL";
  if (dropPct <= -12) return "HIGH";
  if (dropPct <= -10) return "WATCH";
  return null;
}

function getTradingDaysAgo(n: number): string {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  let count = 0;
  const d = new Date(et);
  while (count < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count++;
  }
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

async function fetchGroupedDaily(date: string): Promise<Map<string, number>> {
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return new Map();
  const data = await res.json() as { results?: Array<{ T: string; c: number }> };
  const map = new Map<string, number>();
  for (const bar of data.results ?? []) {
    map.set(bar.T, bar.c);
  }
  return map;
}

const TIER_PRIORITY: Record<WeeklyCapTier, number> = {
  CRITICAL: 0,
  HIGH: 1,
  WATCH: 2,
};

export async function runWeeklyCapitulationScan(): Promise<WeeklyCapScanResponse> {
  const startTime = Date.now();

  // Fetch ticker list + close prices from 5 trading days ago
  const tickers = await getCapitulationTickers();
  const date5dAgo = getTradingDaysAgo(5);
  const [closesMap, snapshots] = await Promise.all([
    fetchGroupedDaily(date5dAgo),
    fetchAllSnapshots(tickers),
  ]);

  const signals: WeeklyCapSignal[] = [];

  for (const ticker of tickers) {
    const snap = snapshots.get(ticker);
    if (!snap) continue;

    const price = getCurrentPrice(snap);
    const close5d = closesMap.get(ticker);
    const open = snap.day?.o ?? 0;

    if (!price || price <= 0 || !close5d || close5d <= 0) continue;

    const dropPct = ((price - close5d) / close5d) * 100;
    const changeFromOpenPct = open > 0 ? ((price - open) / open) * 100 : 0;

    const todayVol = snap.day?.v ?? 0;
    const prevVol = snap.prevDay?.v ?? 0;
    const rvol = prevVol > 0 && todayVol > 0 ? todayVol / prevVol : 0;

    const tier = classifyWeeklyTier(dropPct);
    if (!tier) continue;

    // Only show stocks with positive change from open (recovering)
    if (changeFromOpenPct <= 0) continue;

    signals.push({
      ticker,
      price,
      open,
      close5dAgo: close5d,
      dropPct,
      changeFromOpenPct,
      rvol,
      todayVolume: todayVol,
      prevDayVolume: prevVol,
      tier,
      capitulating: changeFromOpenPct > 0,
    });
  }

  // Sort by % change from open, highest first
  signals.sort((a, b) => b.changeFromOpenPct - a.changeFromOpenPct);

  return {
    signals,
    scannedAt: new Date().toISOString(),
    marketOpen: isMarketOpen(),
    totalScanned: tickers.length,
    scanDurationMs: Date.now() - startTime,
  };
}
