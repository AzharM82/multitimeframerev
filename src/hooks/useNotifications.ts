import { useState, useEffect, useCallback, useRef } from "react";
import type { StockScan, NotificationEntry } from "../types.js";

export function useNotifications(stocks: StockScan[]) {
  const [entries, setEntries] = useState<NotificationEntry[]>([]);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const lastScanIdRef = useRef<string>("");

  useEffect(() => {
    if ("Notification" in window) {
      setPermission(Notification.permission);
      if (Notification.permission === "default") {
        Notification.requestPermission().then(setPermission);
      }
    }
  }, []);

  const playAlert = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch {
      // Audio not available
    }
  }, []);

  useEffect(() => {
    if (stocks.length === 0) return;

    // Dedupe by creating a scan fingerprint so we don't re-log the same scan
    const scanId = stocks.map((s) => `${s.ticker}:${s.score}`).join(",");
    if (scanId === lastScanIdRef.current) return;
    lastScanIdRef.current = scanId;

    const now = new Date().toISOString();
    const newAlerts: NotificationEntry[] = [];

    for (const stock of stocks) {
      // Only alert for perfect conviction: +15 or -15
      if (stock.score !== 15 && stock.score !== -15) continue;

      const type = stock.score > 0 ? "bullish" as const : "bearish" as const;
      newAlerts.push({
        id: `${stock.ticker}-${Date.now()}-${Math.random()}`,
        ticker: stock.ticker,
        type,
        timestamp: now,
        message: `Score ${stock.score > 0 ? "+" : ""}${stock.score} — max conviction ${type}`,
      });

      if (permission === "granted") {
        new Notification(`${stock.ticker} — ${type.toUpperCase()} SCORE ${stock.score > 0 ? "+" : ""}${stock.score}`, {
          body: `Max conviction ${type} signal`,
        });
      }
    }

    if (newAlerts.length > 0) {
      playAlert();
      setEntries((prev) => [...newAlerts, ...prev].slice(0, 50));
    }
  }, [stocks, permission, playAlert]);

  return { entries, permission };
}
