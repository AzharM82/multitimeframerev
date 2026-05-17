"""
FROZEN — Build / refresh the local cache the research loop runs against.

Pulls every row from Azure Table `AlertLog`, plus 1-min Polygon OHLC for
each alert's trading day (08:00–16:00 ET window — pre-market + RTH +
~1 hour of close coverage). Caches OHLC bars on disk so subsequent
backtests are I/O-bound at startup but free afterward.

Outputs:
    data/alerts.parquet        all rows from AlertLog, normalized
    data/bars/{ticker}/{date}.parquet   1-min OHLC per (ticker, date)
    data/train.parquet         alerts in the older 80% (chronological)
    data/val.parquet           alerts in the most-recent 20%

Run:
    uv run prepare.py                  # incremental — skips already-cached bars
    uv run prepare.py --rebuild        # wipe + refetch everything
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests
from azure.data_tables import TableClient
from dotenv import load_dotenv

load_dotenv()
CONN = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
KEY = os.environ.get("POLYGON_API_KEY", "")
if not CONN or not KEY:
    sys.exit("Missing AZURE_STORAGE_CONNECTION_STRING or POLYGON_API_KEY in env / .env")

ROOT = Path(__file__).parent
DATA = ROOT / "data"
BARS = DATA / "bars"
TABLE = "AlertLog"
ET_OPEN_WINDOW = (8, 0)   # 08:00 ET — capture some pre-market
ET_CLOSE_WINDOW = (17, 0) # 17:00 ET — capture extended-hours just in case


def fetch_alerts() -> pd.DataFrame:
    tbl = TableClient.from_connection_string(CONN, TABLE)
    rows = []
    for e in tbl.list_entities():
        rows.append(dict(e))
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["firedAt"] = pd.to_datetime(df["firedAt"], utc=True)
    df = df.sort_values("firedAt").reset_index(drop=True)
    # Drop synthetic / corrupt rows
    df = df[df["reversalPrice"].astype(float) > 0]
    return df


def cache_path(ticker: str, day: str) -> Path:
    return BARS / ticker / f"{day}.parquet"


def fetch_bars(ticker: str, day: str) -> pd.DataFrame:
    """1-min aggs for one trading day. Polygon returns up to ~480 bars covering
    pre-market + RTH + after-hours."""
    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{ticker}/range/1/minute/"
        f"{day}/{day}?adjusted=true&sort=asc&limit=50000&apiKey={KEY}"
    )
    for attempt in range(3):
        r = requests.get(url, timeout=30)
        if r.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        j = r.json()
        results = j.get("results") or []
        if not results:
            return pd.DataFrame()
        df = pd.DataFrame(results)
        df = df.rename(columns={"t": "ts", "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df[["ts", "open", "high", "low", "close", "volume"]]
    raise RuntimeError(f"polygon 429 for {ticker} {day}")


def ensure_bars(df_alerts: pd.DataFrame, rebuild: bool) -> int:
    """Cache 1-min bars for every (ticker, day) covered by alerts."""
    BARS.mkdir(parents=True, exist_ok=True)
    needed = set()
    for _, a in df_alerts.iterrows():
        day = pd.to_datetime(a["firedAt"]).strftime("%Y-%m-%d")
        needed.add((a["ticker"], day))
    fetched = 0
    skipped = 0
    for ticker, day in sorted(needed):
        p = cache_path(ticker, day)
        if p.exists() and not rebuild:
            skipped += 1
            continue
        try:
            bars = fetch_bars(ticker, day)
        except Exception as e:
            print(f"  WARN: {ticker} {day} fetch failed: {e}", file=sys.stderr)
            continue
        if bars.empty:
            # write empty marker so we don't retry on next run
            p.parent.mkdir(parents=True, exist_ok=True)
            bars.to_parquet(p)
            fetched += 1
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        bars.to_parquet(p)
        fetched += 1
        time.sleep(0.04)  # ~25 req/s; Polygon Starter is unlimited but be gentle
    print(f"bars: fetched {fetched} (ticker, day) pairs, skipped {skipped} cached")
    return fetched


def split_train_val(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Chronological 80 / 20. Newer rows go to val so the agent must
    generalize to the *most recent* market regime, not just match the past."""
    if len(df) == 0:
        return df, df
    cutoff_idx = int(len(df) * 0.8)
    return df.iloc[:cutoff_idx].copy(), df.iloc[cutoff_idx:].copy()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="wipe and refetch bar cache")
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    alerts = fetch_alerts()
    print(f"alerts: {len(alerts)} rows")
    if alerts.empty:
        return 0
    alerts.to_parquet(DATA / "alerts.parquet")
    ensure_bars(alerts, rebuild=args.rebuild)
    train, val = split_train_val(alerts)
    train.to_parquet(DATA / "train.parquet")
    val.to_parquet(DATA / "val.parquet")
    print(f"split: train={len(train)} val={len(val)} cutoff={alerts.iloc[int(len(alerts) * 0.8) - 1]['firedAt']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
