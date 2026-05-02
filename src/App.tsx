import { useState } from "react";
import { useMarketHours } from "./hooks/useMarketHours.js";
import { AvwapPage } from "./views/AvwapPage.js";
import { BullListPage } from "./views/BullListPage.js";
import { DayTradePage } from "./views/DayTradePage.js";
import { PerformancePage } from "./views/PerformancePage.js";
import { AboutPage } from "./views/AboutPage.js";

type Page = "avwap" | "bull" | "daytrade" | "performance" | "about";

const TABS: { key: Page; label: string }[] = [
  { key: "avwap", label: "AVWAP" },
  { key: "bull", label: "Bull List" },
  { key: "daytrade", label: "Day Trades" },
  { key: "performance", label: "Performance" },
  { key: "about", label: "About" },
];

function App() {
  const [page, setPage] = useState<Page>("avwap");
  const marketOpen = useMarketHours();

  return (
    <div className="min-h-screen bg-bg-primary">
      <header className="border-b border-border bg-bg-secondary px-6 py-3">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            <nav className="flex gap-1 mr-3">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setPage(t.key)}
                  className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wider transition-colors border-b-2 ${
                    page === t.key
                      ? "text-accent border-accent"
                      : "text-text-secondary border-transparent hover:text-text-primary"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <span
              className={`w-2 h-2 rounded-full ${marketOpen ? "bg-signal-bull animate-pulse" : "bg-signal-bear"}`}
              title={marketOpen ? "Market Open" : "Market Closed"}
            />
            <span className="text-xs text-text-secondary">
              {marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-widest text-text-secondary">
            MTF Reversal · v2
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {page === "avwap" && <AvwapPage />}
        {page === "bull" && <BullListPage />}
        {page === "daytrade" && <DayTradePage />}
        {page === "performance" && <PerformancePage />}
        {page === "about" && <AboutPage />}
      </main>
    </div>
  );
}

export default App;
