import type { PhaseTimeframeSignal } from "../types.js";

const ZONE_COLORS: Record<string, string> = {
  extended_up: "bg-red-600/30 text-red-300",
  distribution: "bg-red-500/20 text-red-400",
  neutral_up: "bg-emerald-500/10 text-emerald-400",
  launch_box: "bg-bg-secondary text-text-secondary",
  neutral_down: "bg-red-500/10 text-red-400",
  accumulation: "bg-emerald-500/20 text-emerald-300",
  extended_down: "bg-emerald-600/30 text-emerald-300",
};

const ZONE_LABELS: Record<string, string> = {
  extended_up: "Ext Up",
  distribution: "Dist",
  neutral_up: "Neut+",
  launch_box: "Launch",
  neutral_down: "Neut-",
  accumulation: "Accum",
  extended_down: "Ext Dn",
};

const LINE_COLOR_CLASS: Record<string, string> = {
  green: "text-emerald-400",
  red: "text-red-400",
  gray: "text-gray-400",
};

interface Props {
  data: PhaseTimeframeSignal;
}

export function PhaseCell({ data }: Props) {
  const zoneColor = ZONE_COLORS[data.zone] ?? "";
  const zoneLabel = ZONE_LABELS[data.zone] ?? "";
  const hasSignal = data.signal !== null;
  const valueColor = LINE_COLOR_CLASS[data.lineColor] ?? "text-text-primary";

  return (
    <td className={`px-3 py-2 text-center ${zoneColor}`}>
      <div className="flex flex-col items-center gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className={`font-mono text-sm font-bold ${valueColor}`}>
            {data.oscillatorValue.toFixed(1)}
          </span>
          {data.compression && (
            <span
              className="w-2 h-2 rounded-full bg-fuchsia-500"
              title="Compression (Bollinger squeeze)"
            />
          )}
        </div>
        <span className="text-[10px] opacity-70">{zoneLabel}</span>
        {hasSignal && (
          <span
            className={`text-[10px] font-bold px-1.5 py-px rounded ${
              data.signal === "oversold"
                ? "bg-emerald-500/30 text-emerald-300"
                : "bg-red-500/30 text-red-300"
            }`}
          >
            {data.signal === "oversold" ? "BUY" : "SELL"}
          </span>
        )}
      </div>
    </td>
  );
}
