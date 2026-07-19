import { useEffect, useState } from "react";
import { useMarketHours } from "./hooks/useMarketHours.js";
import { useAuth } from "./hooks/useAuth.js";
import { AtrMatrixPage } from "./views/AtrMatrixPage.js";
import { CveEvalPage } from "./views/CveEvalPage.js";
import { BigdIntradayPage } from "./views/BigdIntradayPage.js";
import { UnusualOptionsPage } from "./views/UnusualOptionsPage.js";
import { RotationPage } from "./views/RotationPage.js";
import { GatePage } from "./views/GatePage.js";
import { AboutPage } from "./views/AboutPage.js";

type Page = "gate" | "atr" | "uoa" | "cve" | "bigd" | "rotation" | "about";

const TABS: { key: Page; label: string }[] = [
  { key: "gate", label: "Gate" },
  { key: "atr", label: "ATR Matrix" },
  { key: "uoa", label: "Unusual Options" },
  { key: "cve", label: "Catalyst Value Eval" },
  { key: "bigd", label: "BIGD-Intraday" },
  { key: "rotation", label: "Rotation" },
  { key: "about", label: "About" },
];

const PAGE_KEYS = TABS.map((t) => t.key);
function initialPage(): Page {
  const h = window.location.hash.replace("#", "") as Page;
  return PAGE_KEYS.includes(h) ? h : "atr";
}

function App() {
  const [page, setPageState] = useState<Page>(initialPage);
  const setPage = (p: Page) => {
    setPageState(p);
    window.history.replaceState(null, "", `#${p}`); // deep-linkable tabs (e.g. /#uoa)
  };
  useEffect(() => {
    const onHashChange = () => setPageState(initialPage());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const marketOpen = useMarketHours();
  const { user } = useAuth();

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
        <span className="flex items-center gap-3">
          <span className="text-[10px] text-dim font-medium">{today}</span>
          {user && (
            <span className="flex items-center gap-2 text-[10px] text-text-secondary">
              <span className="hidden sm:inline font-medium">{user.userDetails}</span>
              <a
                href="/logout"
                className="uppercase tracking-wider font-semibold hover:text-text-primary transition-colors"
              >
                Sign out
              </a>
            </span>
          )}
        </span>
      </div>

      {/* Main content — full width */}
      <main className="px-3 py-4">
        {page === "gate" && <GatePage />}
        {page === "atr" && <AtrMatrixPage />}
        {page === "uoa" && <UnusualOptionsPage />}
        {page === "cve" && <CveEvalPage />}
        {page === "bigd" && <BigdIntradayPage />}
        {page === "rotation" && <RotationPage />}
        {page === "about" && <AboutPage />}
      </main>

      {/* Footer */}
      <footer className="flex items-center justify-between px-4 py-2.5 bg-bg-card border-t border-border text-[10px] uppercase tracking-wider text-text-secondary">
        <span className="font-semibold">MTF Reversal Suite</span>
        <span>Data: Polygon.io · Not financial advice</span>
      </footer>
    </div>
  );
}

export default App;
