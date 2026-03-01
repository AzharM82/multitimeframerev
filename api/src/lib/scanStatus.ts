export interface ScanStatus {
  scanning: boolean;
  currentTicker: string | null;
  completedTickers: string[];
  totalTickers: number;
  message: string;
}

let status: ScanStatus = {
  scanning: false,
  currentTicker: null,
  completedTickers: [],
  totalTickers: 0,
  message: "Idle",
};

export function getStatus(): ScanStatus {
  return { ...status, completedTickers: [...status.completedTickers] };
}

export function startScan(totalTickers: number): void {
  status = {
    scanning: true,
    currentTicker: null,
    completedTickers: [],
    totalTickers,
    message: `Starting scan of ${totalTickers} ticker${totalTickers > 1 ? "s" : ""}...`,
  };
}

export function updateScanTicker(ticker: string): void {
  status.currentTicker = ticker;
  const done = status.completedTickers.length;
  status.message = `Fetching data for ${ticker}... (${done + 1}/${status.totalTickers})`;
}

export function completeTicker(ticker: string): void {
  status.completedTickers.push(ticker);
  const done = status.completedTickers.length;
  if (done >= status.totalTickers) {
    status.message = `Analyzing signals for ${status.totalTickers} ticker${status.totalTickers > 1 ? "s" : ""}...`;
    status.currentTicker = null;
  } else {
    status.message = `Completed ${ticker} (${done}/${status.totalTickers})`;
  }
}

export function finishScan(stockCount: number, errorCount: number): void {
  const parts: string[] = [`Scan complete — ${stockCount} stock${stockCount !== 1 ? "s" : ""} analyzed`];
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
  status = {
    scanning: false,
    currentTicker: null,
    completedTickers: [],
    totalTickers: 0,
    message: parts.join(", "),
  };
}
