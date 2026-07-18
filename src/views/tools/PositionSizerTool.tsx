import { useMemo, useState } from "react";
import { computeSizer } from "./useSizer.js";

/**
 * Position Sizer — consolidates the sizing calculators from three standalone
 * apps ("Rule Based Day Trading", "Rule Based Stock Day Trading", "Position
 * Management") into one form backed by `computeSizer`.
 *
 * Shows BOTH constraints rather than only the answer: the original calculators
 * printed a share count without saying whether risk or capital was the binding
 * limit, which is the thing you actually need in order to adjust the trade.
 */

const STORAGE_KEY = "tools:sizer:v2";

type Instrument = "options" | "stock";

interface SizerForm {
  capital: number;
  positionCount: number;
  riskBudget: number;
  entry: number;
  stop: number;
  instrument: Instrument;
}

const DEFAULTS: SizerForm = {
  capital: 20000,
  positionCount: 1,
  riskBudget: 500,
  entry: 1.0,
  stop: 0.5,
  instrument: "options",
};

function loadForm(): SizerForm {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };

    // Migrate the legacy key written by "Rule Based Day Trading".
    // Left in place rather than removed, so the original tool still works
    // during the overlap. See the migration note in the consolidation plan.
    const legacy = localStorage.getItem("positionSizer:v1");
    if (legacy) {
      const p = JSON.parse(legacy);
      return {
        ...DEFAULTS,
        capital: Number(p.totalCapital) || DEFAULTS.capital,
        riskBudget: Number(p.riskAmount) || DEFAULTS.riskBudget,
        entry: Number(p.entryPrice) || DEFAULTS.entry,
        stop: Number(p.stopPrice) || DEFAULTS.stop,
      };
    }
  } catch {
    /* corrupt or unavailable storage falls through to defaults */
  }
  return DEFAULTS;
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

function Field({
  label, value, onChange, step = "any", hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[9px] uppercase tracking-widest text-text-secondary mb-1">{label}</span>
      <input
        type="number"
        step={step}
        min="0"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs tabular-nums
                   focus:outline-none focus:border-accent"
      />
      {hint && <span className="block text-[9.5px] text-dim mt-1">{hint}</span>}
    </label>
  );
}

export function PositionSizerTool() {
  const [form, setForm] = useState<SizerForm>(loadForm);

  const set = <K extends keyof SizerForm>(key: K, value: SizerForm[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private browsing — calculator still works, it just will not persist */
      }
      return next;
    });
  };

  const multiplier = form.instrument === "options" ? 100 : 1;
  const unit = form.instrument === "options" ? "contract" : "share";

  const r = useMemo(
    () => computeSizer({ ...form, multiplier }),
    [form, multiplier],
  );

  const limitLabel =
    r.limitedBy === "risk" ? "Risk-limited"
    : r.limitedBy === "capital" ? "Capital-limited"
    : r.limitedBy === "both" ? "Both limits equal"
    : "No position";

  const limitClass =
    r.limitedBy === "risk" ? "text-signal-bear border-signal-bear"
    : r.limitedBy === "capital" ? "text-accent border-accent"
    : r.limitedBy === "both" ? "text-signal-neutral border-signal-neutral"
    : "text-text-secondary border-border";

  const stopAboveEntry = form.stop >= form.entry && form.entry > 0;

  return (
    <div className="space-y-4">
      {/* ─── Inputs ─────────────────────────────────────────────── */}
      <div className="bg-bg-card border border-border rounded">
        <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary flex items-center">
          Account &amp; Trade
          <span className="flex-1" />
          <span className="flex gap-1">
            {(["options", "stock"] as const).map((i) => (
              <button
                key={i}
                onClick={() => set("instrument", i)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                  form.instrument === i
                    ? "bg-text-primary text-bg-primary border-text-primary"
                    : "border-border text-text-secondary hover:text-text-primary"
                }`}
              >
                {i === "options" ? "Options ×100" : "Stock ×1"}
              </button>
            ))}
          </span>
        </div>

        <div className="p-3 grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Total Capital" value={form.capital} onChange={(n) => set("capital", n)} />
          <Field
            label="Concurrent Positions"
            value={form.positionCount}
            step="1"
            onChange={(n) => set("positionCount", n)}
            hint={`Allocation ${usd(r.allocation)}`}
          />
          <Field
            label="Risk Budget ($)"
            value={form.riskBudget}
            onChange={(n) => set("riskBudget", n)}
            hint={
              r.allocation > 0
                ? `${pct(form.riskBudget / r.allocation)} of allocation`
                : undefined
            }
          />
          <Field label="Entry Price" value={form.entry} onChange={(n) => set("entry", n)} />
          <Field label="Stop Price" value={form.stop} onChange={(n) => set("stop", n)} />
          <div className="flex items-end">
            <div className="text-[10px] text-text-secondary leading-snug">
              Risk / {unit}: <b className="tabular-nums text-text-primary">{usd(r.riskPerUnit)}</b>
              <br />
              Cost / {unit}: <b className="tabular-nums text-text-primary">{usd(r.costPerUnit)}</b>
            </div>
          </div>
        </div>

        {stopAboveEntry && (
          <div className="px-3 pb-3 -mt-1">
            <div className="text-[10.5px] text-signal-bear border-l-2 border-signal-bear pl-2 py-1">
              Stop is at or above entry — no long position is sizeable. Quantity is held at zero
              rather than inverting the calculation.
            </div>
          </div>
        )}
      </div>

      {/* ─── Result ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">
            {form.instrument === "options" ? "Contracts" : "Shares"} to Buy
          </div>
          <div className="font-[var(--font-playfair)] text-3xl font-black leading-none tabular-nums">
            {r.quantity}
          </div>
          <div className={`inline-block mt-2 px-2 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wider ${limitClass}`}>
            {limitLabel}
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">Position Size</div>
          <div className="font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums">
            {usd(r.positionSize)}
          </div>
          <div className="text-[10px] text-text-secondary mt-1.5">
            {usd(r.capitalRemaining)} left of allocation
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">At Risk</div>
          <div className="font-[var(--font-playfair)] text-2xl font-black leading-tight tabular-nums text-signal-bear">
            {usd(r.dollarsAtRisk)}
          </div>
          <div className="text-[10px] text-text-secondary mt-1.5">
            {pct(r.percentOfCapitalRisked)} of total capital
          </div>
        </div>

        <div className="bg-bg-card border border-border rounded p-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary mb-1.5">Constraints</div>
          <table className="w-full text-[11px] tabular-nums">
            <tbody>
              <tr>
                <td className="text-text-secondary py-0.5">By risk</td>
                <td className="text-right font-semibold">{r.maxByRisk}</td>
              </tr>
              <tr>
                <td className="text-text-secondary py-0.5">By capital</td>
                <td className="text-right font-semibold">{r.maxByCapital}</td>
              </tr>
              <tr className="border-t border-border">
                <td className="text-text-secondary py-0.5">Binding</td>
                <td className="text-right font-semibold">{r.quantity}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] uppercase tracking-wider text-text-secondary text-center pb-2">
        Smaller of the two constraints wins · Sizing uses the risk budget you enter
      </p>
    </div>
  );
}
