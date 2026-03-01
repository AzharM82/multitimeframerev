import { useState, useCallback, useRef } from "react";
import type { ScanResponse, ScanStatus } from "../types.js";
import { runScan, getScanStatus } from "../services/api.js";

interface UseScanPollingResult {
  data: ScanResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  status: ScanStatus | null;
}

const IDLE_STATUS: ScanStatus = {
  scanning: false,
  currentTicker: null,
  completedTickers: [],
  totalTickers: 0,
  message: "Idle",
};

export function useScanPolling(): UseScanPollingResult {
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanningRef = useRef(false);

  const stopStatusPolling = useCallback(() => {
    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = null;
    }
  }, []);

  const startStatusPolling = useCallback(() => {
    if (statusIntervalRef.current) return;
    statusIntervalRef.current = setInterval(async () => {
      try {
        const s = await getScanStatus();
        setStatus(s);
      } catch {
        // ignore
      }
    }, 2000);
  }, []);

  const doScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;

    setLoading(true);
    setError(null);
    setStatus({ ...IDLE_STATUS, scanning: true, message: "Initiating scan..." });
    startStatusPolling();

    try {
      const result = await runScan();
      setData(result);
      try {
        const s = await getScanStatus();
        setStatus(s);
      } catch {
        setStatus(IDLE_STATUS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setStatus(null);
    } finally {
      setLoading(false);
      stopStatusPolling();
      scanningRef.current = false;
    }
  }, [startStatusPolling, stopStatusPolling]);

  return { data, loading, error, refresh: doScan, status };
}
