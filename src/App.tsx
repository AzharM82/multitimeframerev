import { useState } from "react";
import { useMarketHours } from "./hooks/useMarketHours.js";
import { AvwapPage } from "./views/AvwapPage.js";
import { BullListPage } from "./views/BullListPage.js";
import { DayTradePage } from "./views/DayTradePage.js";
import { AtrMatrixPage } from "./views/AtrMatrixPage.js";
import { AboutPage } from "./views/AboutPage.js";

type Page = "avwap" | "bull" | "daytrade" | "atr" | "about";

const TABS: { key: Page; label: string }[] = [
  { key: "avwap", label: "AVWAP" },
  { key: "bull", label: "Bull List" },
  { key: "daytrade", label: "Day Trades" },
  { key: "atr", label: "ATR Matrix" },
  { key: "about", label: "About" },
];

function App() {
  const [page, setPage] = useState<Page>("avwap");
  const marketOpen = useMarketHours();

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Los_Angeles",
  });

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Masthead */}
      <header className="text-center pt-5 pb-3 border-b border-border bg-bg-card">
        <h1 className="font-[var(--font-playfair)] text-3xl font-black tracking-tight text-text-primary">
          Multi-Timeframe Reversal
        </h1>
        <p className="text-xs text-text-secondary mt-0.5 tracking-widest uppercase font-medium">
          Swing &amp; Day-Trade Scanner Suite
        </p>
      </header>

      {/* Navigation */}
      <nav className="bg-bg-card border-b border-border">
        <div className="flex items-center justify-center gap-1 px-4 py-2 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setPage(t.key)}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                page === t.key
                  ? "bg-text-primary text-bg-primary"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Newspaper double rule */}
      <div className="newspaper-rule mx-3" />

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-bg-secondary border-b border-border">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
          <span className={`w-2 h-2 rounded-full ${marketOpen ? "bg-signal-bull animate-pulse" : "bg-signal-bear"}`} />
          {marketOpen ? "Market Open" : "Market Closed"}
        </span>
        <span className="text-[10px] text-dim font-medium">{today}</span>
      </div>

      {/* Main content — full width */}
      <main className="px-3 py-4">
        {page === "avwap" && <AvwapPage />}
        {page === "bull" && <BullListPage />}
        {page === "daytrade" && <DayTradePage />}
        {page === "atr" && <AtrMatrixPage />}
        {page === "about" && <AboutPage />}
      </main>
    </div>
  );
}

export default App;
