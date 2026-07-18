import { useState } from "react";
import { PositionSizerTool } from "./tools/PositionSizerTool.js";

/**
 * Tools — consolidates four standalone calculators that previously lived as
 * loose HTML files and one non-compiling CRA app:
 *
 *   Screener       ← "High Probability Winner"        (18-point options screen)
 *   Trade Manager  ← "Rule Based Day Trading"         (+ its share-based fork)
 *   Position Sizer ← "Position Management"            (+ both Rule Based sizers)
 *
 * Purely client-side: no API calls, no secrets, no scheduled work. State lives
 * in localStorage under the `tools:*` namespace, migrating the legacy keys the
 * standalone apps wrote.
 *
 * Sub-navigation is local state rather than a router — the portal has no router
 * and the top-level tab key already owns the URL hash.
 */

type Tool = "sizer" | "screener" | "manager";

const TOOLS: { key: Tool; label: string }[] = [
  { key: "sizer", label: "Position Sizer" },
  { key: "screener", label: "Screener" },
  { key: "manager", label: "Trade Manager" },
];

const ACTIVE_KEY = "tools:activeTool";

function initialTool(): Tool {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY) as Tool | null;
    if (saved && TOOLS.some((t) => t.key === saved)) return saved;
  } catch {
    /* ignore unavailable storage */
  }
  return "sizer";
}

/** Placeholder for sub-tools not yet ported, so the nav shape is honest about what exists. */
function NotYetPorted({ name, source }: { name: string; source: string }) {
  return (
    <div className="max-w-lg mx-auto text-center py-16">
      <div className="font-[var(--font-playfair)] text-lg font-bold mb-2">{name}</div>
      <p className="text-sm text-text-secondary">
        Not ported yet — still lives in <code className="text-[11px]">{source}</code>.
      </p>
    </div>
  );
}

export function ToolsPage() {
  const [tool, setToolState] = useState<Tool>(initialTool);

  const setTool = (t: Tool) => {
    setToolState(t);
    try {
      localStorage.setItem(ACTIVE_KEY, t);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Sub-navigation */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTool(t.key)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
              tool === t.key
                ? "bg-text-primary text-bg-primary border-text-primary"
                : "border-border text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tool === "sizer" && <PositionSizerTool />}
      {tool === "screener" && (
        <NotYetPorted name="Screener" source="High Probability Winner/index.html" />
      )}
      {tool === "manager" && (
        <NotYetPorted name="Trade Manager" source="Rule Based Day Trading/index.html" />
      )}
    </div>
  );
}
