"""
MUTABLE — this is the file the research agent edits.

Implements three pure functions the evaluator calls for every cached alert:

    should_take(alert)         -> bool          # filter
    position_size(alert)       -> float         # dollars at risk
    exit_rule(alert, bars)     -> (exit_price, exit_reason, exit_ts)

Defaults below replicate the live system as of the baseline:
- Take every alert that made it into ALERT_LOG (the scanner already filtered
  for fresh REV U + plausibility).
- $1000 notional per trade.
- Exit at 3% target OR at the 3-bar-low SL, whichever the 1-min bars hit
  first. If neither hits, exit at end-of-day close.

The agent should mutate these functions to find improvements. The signature
is the contract — keep these signatures stable so evaluate.py keeps working.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd


# ─── Tunables (the agent may also edit these constants) ──────────────────
NOTIONAL_PER_TRADE = 1000.0       # $ per signal
TARGET_PCT = 0.03                 # +3% take-profit
SL_LOOKBACK_BARS = 3              # bars used to derive the stop-loss
DEFAULT_SL_PCT_FALLBACK = 0.02    # if alert has no `sl`, assume 2% below entry


@dataclass
class Alert:
    ticker: str
    firedAt: datetime
    reversalPrice: float
    sl: float | None         # stored on row when present
    slPct: float | None


def alert_from_row(row: dict) -> Alert:
    """Adapter from a DataFrame row dict to the strategy's Alert shape."""
    return Alert(
        ticker=row["ticker"],
        firedAt=pd.to_datetime(row["firedAt"], utc=True).to_pydatetime(),
        reversalPrice=float(row["reversalPrice"]),
        sl=float(row["sl"]) if row.get("sl") not in (None, "") and pd.notna(row.get("sl")) else None,
        slPct=float(row["slPct"]) if row.get("slPct") not in (None, "") and pd.notna(row.get("slPct")) else None,
    )


# ─── Filter / sizing / exit ──────────────────────────────────────────────

def should_take(alert: Alert) -> bool:
    """Default: take every alert. The agent should add filters here."""
    return True


def position_size(alert: Alert) -> float:
    """Default: fixed $1000 notional. The agent may make this signal-dependent."""
    return NOTIONAL_PER_TRADE


def exit_rule(alert: Alert, bars: pd.DataFrame) -> tuple[float, str, datetime]:
    """Given the 1-min bars from `firedAt` onward, decide where the trade exits.

    Returns:
        (exit_price, exit_reason in {"TP", "SL", "EOD"}, exit_ts)
    """
    entry = alert.reversalPrice
    tp_price = entry * (1 + TARGET_PCT)
    sl_price = alert.sl if alert.sl else entry * (1 - DEFAULT_SL_PCT_FALLBACK)

    # Walk bars in order from firedAt forward. First touch of TP or SL wins.
    # Tiebreaker on a bar that touches both: SL (conservative).
    started = bars[bars["ts"] >= pd.Timestamp(alert.firedAt)]
    if started.empty:
        return (entry, "NO_DATA", alert.firedAt)
    for _, b in started.iterrows():
        if b["low"] <= sl_price:
            return (sl_price, "SL", b["ts"].to_pydatetime())
        if b["high"] >= tp_price:
            return (tp_price, "TP", b["ts"].to_pydatetime())
    last = started.iloc[-1]
    return (float(last["close"]), "EOD", last["ts"].to_pydatetime())
