"""
FROZEN — Replays cached alerts through strategy.py and prints a structured
summary the agent greps. The single scalar metric the agent optimizes is
`metric:` (lower is better — it's negated expected P&L per signal).

Run:
    uv run evaluate.py                 # eval on val + train, print both
    uv run evaluate.py --split train   # eval only on train
    uv run evaluate.py --split val     # eval only on val

The "metric" line is on stdout; everything else may go to stderr. Agent
greps `^metric:` to score a trial.
"""
from __future__ import annotations
import argparse
import math
import sys
from pathlib import Path

import pandas as pd

# Strategy is imported here so the agent's edits take effect on next run.
from strategy import alert_from_row, exit_rule, position_size, should_take

ROOT = Path(__file__).parent
DATA = ROOT / "data"
BARS = DATA / "bars"


def load_bars(ticker: str, day: str) -> pd.DataFrame:
    p = BARS / ticker / f"{day}.parquet"
    if not p.exists():
        return pd.DataFrame()
    return pd.read_parquet(p)


def backtest(df_alerts: pd.DataFrame) -> dict:
    trades = []
    skipped_filter = 0
    skipped_nodata = 0
    for _, row in df_alerts.iterrows():
        a = alert_from_row(row.to_dict())
        if not should_take(a):
            skipped_filter += 1
            continue
        day = a.firedAt.strftime("%Y-%m-%d")
        bars = load_bars(a.ticker, day)
        if bars.empty:
            skipped_nodata += 1
            continue
        notional = position_size(a)
        exit_price, reason, _ts = exit_rule(a, bars)
        pnl_dollars = (exit_price - a.reversalPrice) / a.reversalPrice * notional
        pnl_pct = (exit_price - a.reversalPrice) / a.reversalPrice * 100.0
        trades.append({
            "ticker": a.ticker, "entry": a.reversalPrice, "exit": exit_price,
            "reason": reason, "pnl_dollars": pnl_dollars, "pnl_pct": pnl_pct,
        })
    if not trades:
        return {"n_trades": 0, "skipped_filter": skipped_filter, "skipped_nodata": skipped_nodata}
    df = pd.DataFrame(trades)
    wins = df[df["pnl_dollars"] > 0]
    losses = df[df["pnl_dollars"] < 0]
    gross_win = float(wins["pnl_dollars"].sum()) if len(wins) else 0.0
    gross_loss = float(-losses["pnl_dollars"].sum()) if len(losses) else 0.0
    return {
        "n_trades": len(df),
        "skipped_filter": skipped_filter,
        "skipped_nodata": skipped_nodata,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(df),
        "total_pnl": float(df["pnl_dollars"].sum()),
        "expected_pnl": float(df["pnl_dollars"].mean()),
        "stdev_pnl": float(df["pnl_dollars"].std()) if len(df) > 1 else 0.0,
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else math.inf,
        "tp_hits": int((df["reason"] == "TP").sum()),
        "sl_hits": int((df["reason"] == "SL").sum()),
        "eod_exits": int((df["reason"] == "EOD").sum()),
    }


def print_summary(label: str, s: dict) -> None:
    print(f"=== {label} ===")
    if s.get("n_trades", 0) == 0:
        print(f"n_trades: 0  skipped_filter={s.get('skipped_filter', 0)}  skipped_nodata={s.get('skipped_nodata', 0)}")
        return
    print(f"n_trades:       {s['n_trades']}  (skipped_filter={s['skipped_filter']}, skipped_nodata={s['skipped_nodata']})")
    print(f"wins / losses:  {s['wins']} / {s['losses']}")
    print(f"win_rate:       {s['win_rate']:.3f}")
    print(f"total_pnl:      {s['total_pnl']:+.2f}")
    print(f"expected_pnl:   {s['expected_pnl']:+.4f}")
    print(f"stdev_pnl:      {s['stdev_pnl']:.4f}")
    print(f"profit_factor:  {s['profit_factor']:.3f}")
    print(f"exits TP/SL/EOD: {s['tp_hits']} / {s['sl_hits']} / {s['eod_exits']}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["train", "val", "both"], default="both")
    args = ap.parse_args()

    train = pd.read_parquet(DATA / "train.parquet") if (DATA / "train.parquet").exists() else pd.DataFrame()
    val = pd.read_parquet(DATA / "val.parquet") if (DATA / "val.parquet").exists() else pd.DataFrame()
    if train.empty and val.empty:
        sys.exit("no cached data — run `uv run prepare.py` first")

    s_train = backtest(train) if args.split in ("train", "both") and not train.empty else None
    s_val = backtest(val) if args.split in ("val", "both") and not val.empty else None
    if s_train:
        print_summary("TRAIN", s_train)
    if s_val:
        print_summary("VAL", s_val)

    # The scalar metric the agent optimizes. Convention: lower = better, so
    # we negate expected_pnl. Prefer val to discourage overfitting; if val is
    # empty (smoke runs) fall back to train.
    primary = s_val if (s_val and s_val.get("n_trades", 0) > 0) else s_train
    if not primary or primary.get("n_trades", 0) == 0:
        print("metric: inf")
        return 1
    metric = -primary["expected_pnl"]
    print(f"metric: {metric:.6f}")
    print(f"split_used: {'val' if primary is s_val else 'train'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
