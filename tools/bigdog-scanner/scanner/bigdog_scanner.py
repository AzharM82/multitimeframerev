"""
BigDog Trades — Finviz → TOS → OCR → score → alert scanner.

Pulls two Finviz Elite screener exports (a bullish and a bearish universe),
loads each ticker into a dedicated TOS chart window (running the BigDog_OCR
study), OCRs the consolidated label strip, reads the on-chart signed score, and
alerts via WhatsApp (Pushover opt-in) + logs the full feature payload to the MTF
portal.

Chart-truth: the score AND every value come off the BigDog_OCR strip your
studies draw — no server-side re-derivation. Python recomputes the score from
the features only as a fallback / QA cross-check.

Strip fields (see thinkscript/BigDog_OCR.tos):
  Reversal   TREND UP/DN/FLAT  +  REV U/D $price M/D HH:MM Nb
  VWAP       BD VW A|B <int>     close above/below VWAP
  ATR line   BD AT A|B <int>     close above/below ATR line
  Buy vol %  BD BV <int>         buy-volume percent of last bar
  Cum TICK   BD CT P|N <int>     day breadth: green vs red histogram bars (signed)
  Stoch      BD ST <k> <d>       SlowK / SlowD
  Score      BD SC P|N|Z <int>   composite signed score, -6..+6

Scoring (signed, -6..+6): each metric +1 bullish / -1 bearish / 0 neutral
(reversal has NO freshness gate). Bull universe alerts at score >= +ALERT_MIN;
bear universe alerts at score <= -ALERT_MIN (default 3).

Workflow per scan cycle:
  1. Gate: skip if outside market hours (default 6:30 AM – 1:00 PM PT, weekdays).
  2. For each universe (bull, bear): pull Finviz export → tickers.
  3. Find dedicated TOS scanner chart window (config: TOS_SCANNER_WINDOW).
  4. For each ticker: Ctrl+L → type → Enter → wait → PrintWindow → crop → OCR →
     parse → read score → alert if it clears the universe's gate.

Required env (read from .env in this directory or process env):
  FINVIZ_API_KEY, FINVIZ_SCREENER_URL_BULL, FINVIZ_SCREENER_URL_BEAR
  PUSHOVER_USER_KEY, PUSHOVER_APP_TOKEN
  AZURE_STORAGE_CONNECTION_STRING, WHATSAPP_QUEUE_NAME, WHATSAPP_RECEIVER
  TIMER_SECRET, SCANNER_API_BASE, TOS_SCANNER_WINDOW
Tunable (optional, defaults below):
  ALERT_MIN (3), BUY_PCT_MIN (70), ENABLE_PUSHOVER (false),
  SCANNER_LOAD_WAIT_S, SCANNER_KEY_INTERVAL_S

Usage:
  python bigdog_scanner.py             # one full scan cycle (Task Scheduler entry)
  python bigdog_scanner.py --dry-run   # OCR + score, no alerts
  python bigdog_scanner.py --show-text # print raw OCR + parsed features per ticker
  python bigdog_scanner.py --max 5     # limit to first 5 tickers (debug)
  python bigdog_scanner.py --force     # ignore market-hours gate
"""

import argparse
import base64
import csv
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

try:
    import pyautogui
    import win32gui
    import win32con
    HAVE_WIN_AUTOMATION = True
except ImportError:
    HAVE_WIN_AUTOMATION = False

# ─── Config ──────────────────────────────────────────────────────────────────
LOAD_WAIT_S    = float(os.environ.get("SCANNER_LOAD_WAIT_S", "2.0"))
KEY_INTERVAL_S = float(os.environ.get("SCANNER_KEY_INTERVAL_S", "0.025"))
MARKET_OPEN_PT_MIN  = 6 * 60 + 30   # 6:30 AM PT
MARKET_CLOSE_PT_MIN = 13 * 60       # 1:00 PM PT
STATE_FILE = Path(__file__).parent / ".state" / "scanner_state.json"
WORKSPACE  = Path(__file__).parent / ".state" / "captures"

API_BASE = os.environ.get("SCANNER_API_BASE",
                          "https://salmon-river-0a7a0c30f.1.azurestaticapps.net")
QUEUE_NAME = os.environ.get("WHATSAPP_QUEUE_NAME", "whatsapp-alerts")
RECEIVER = os.environ.get("WHATSAPP_RECEIVER", "")
TIMER_SECRET = os.environ.get("TIMER_SECRET", "")
TOS_SCANNER_WINDOW = os.environ.get("TOS_SCANNER_WINDOW", "")
FINVIZ_API_KEY = os.environ.get("FINVIZ_API_KEY", "")
# Two directional universes; legacy FINVIZ_SCREENER_URL is treated as the bull list.
FINVIZ_SCREENER_URL_BULL = os.environ.get("FINVIZ_SCREENER_URL_BULL") or os.environ.get("FINVIZ_SCREENER_URL", "")
FINVIZ_SCREENER_URL_BEAR = os.environ.get("FINVIZ_SCREENER_URL_BEAR", "")
PUSHOVER_USER_KEY = os.environ.get("PUSHOVER_USER_KEY", "")
PUSHOVER_APP_TOKEN = os.environ.get("PUSHOVER_APP_TOKEN", "")
# WhatsApp is the primary channel; Pushover is opt-in (set ENABLE_PUSHOVER=true).
ENABLE_PUSHOVER = os.environ.get("ENABLE_PUSHOVER", "false").strip().lower() in ("1", "true", "yes", "on")

STRIP_PCT = 0.08


def load_cfg() -> dict:
    """Scoring config. The score itself is computed on-chart (BD SC chip); these
    only drive the alert gate + the Python fallback recompute / cross-check.
    ALERT_MIN=3 → bull alerts at score>=+3, bear at score<=-3.
    BUY_PCT_MIN=70 must match the study's bdBuyThresh input."""
    return {
        "BUY_PCT_MIN": float(os.environ.get("BUY_PCT_MIN", "70")),
        "ALERT_MIN":   int(os.environ.get("ALERT_MIN", "3")),
    }


# ─── OCR pipeline (mirror of finviz_scanner.py) ──────────────────────────────
_engine = None
def _get_engine() -> RapidOCR:
    global _engine
    if _engine is None:
        _engine = RapidOCR()
    return _engine


def crop_strip(image_path: Path) -> np.ndarray:
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    strip = img.crop((0, 0, w, int(h * STRIP_PCT)))
    strip = strip.resize((strip.width * 2, strip.height * 2), Image.LANCZOS)
    return cv2.cvtColor(np.array(strip), cv2.COLOR_RGB2BGR)


def run_ocr(img: np.ndarray) -> list[str]:
    result, _ = _get_engine()(img)
    if not result:
        return []
    items = sorted(
        ((min(p[0] for p in bbox), text) for bbox, text, _conf in result),
        key=lambda t: t[0],
    )
    return [t for _, t in items]


# ─── Parsing ─────────────────────────────────────────────────────────────────
_TICKER_RE = re.compile(r"^([A-Z]{1,6})(?=\d|\s|[^A-Z]|$)")
_TREND_RE  = re.compile(r"\bTREND\s*(UP|DN|FLAT)\b", re.IGNORECASE)
_REV_RE = re.compile(
    r"\bREV\s*(?P<dir>[UD])\s*[\$S]?\s*(?P<price>\d+\.\d{2})\s*"
    r"(?P<date>\d{1,2}/\d{1,2})\s*"
    r"(?P<time>\d{2}:\d{2})\s*"
    r"(?P<bars>\d+)\s*[bB]\b",
    re.IGNORECASE,
)
# BigDog chips — anchored on the "BD <code>" prefix so they survive box merges.
# Digits allow a stray ".0" tail from ThinkScript double→string (regex stops at the dot).
_BD_VW = re.compile(r"BD\s*VW\s*([AB])\s*(\d+)", re.IGNORECASE)
_BD_AT = re.compile(r"BD\s*AT\s*([AB])\s*(\d+)", re.IGNORECASE)
_BD_BV = re.compile(r"BD\s*BV\s*(\d{1,3})", re.IGNORECASE)
_BD_CT = re.compile(r"BD\s*CT\s*([PN])\s*(\d+)", re.IGNORECASE)   # day green-red balance
_BD_ST = re.compile(r"BD\s*ST\s*(\d{1,3})\s*([AB])\s*(\d{1,3})", re.IGNORECASE)  # k, K><D letter, d
_BD_SC = re.compile(r"BD\s*SC\s*([PNZ])\s*(\d)", re.IGNORECASE)   # on-chart signed score

_TREND_MAP = {"UP": "U", "DN": "D", "FLAT": "F"}


def parse_bigdog_strip(lines: list[str]) -> dict:
    """Parse the consolidated BigDog_OCR strip into raw features. Any missing
    chip is left None — itself a QA/research signal (OCR miss vs genuinely absent)."""
    blob = " ".join(lines)
    f: dict = {
        "ticker": None,
        "rv_dir": None, "rv_bars": None, "rv_price": None, "rv_date": None, "rv_time": None,
        "trend": None,
        "vwap_side": None, "vwap": None,
        "atr_side": None, "atr": None,
        "buy_pct": None,
        "tick": None,          # day green-red histogram-bar balance (signed)
        "stoch_k": None, "stoch_d": None, "stoch_side": None,  # side = A(K>D)/B(K<D)
        "score": None,         # on-chart signed composite score (BD SC), -6..+6
    }
    if lines and (m := _TICKER_RE.match(lines[0].strip())):
        f["ticker"] = m.group(1)
    if (m := _TREND_RE.search(blob)):
        f["trend"] = _TREND_MAP.get(m.group(1).upper())
    if (m := _REV_RE.search(blob)):
        f["rv_dir"]   = m.group("dir").upper()
        f["rv_price"] = float(m.group("price"))
        f["rv_date"]  = m.group("date")
        f["rv_time"]  = m.group("time")
        f["rv_bars"]  = int(m.group("bars"))
    if (m := _BD_VW.search(blob)):
        f["vwap_side"] = m.group(1).upper()
        f["vwap"] = int(m.group(2))
    if (m := _BD_AT.search(blob)):
        f["atr_side"] = m.group(1).upper()
        f["atr"] = int(m.group(2))
    if (m := _BD_BV.search(blob)):
        f["buy_pct"] = int(m.group(1))
    if (m := _BD_CT.search(blob)):
        sign = -1 if m.group(1).upper() == "N" else 1
        f["tick"] = sign * int(m.group(2))
    if (m := _BD_ST.search(blob)):
        f["stoch_k"] = int(m.group(1))
        f["stoch_side"] = m.group(2).upper()
        f["stoch_d"] = int(m.group(3))
    if (m := _BD_SC.search(blob)):
        sign = {"P": 1, "N": -1, "Z": 0}[m.group(1).upper()]
        f["score"] = sign * int(m.group(2))
    return f


# ─── Scoring (signed, -6..+6) ────────────────────────────────────────────────
def compute_parts(f: dict, cfg: dict) -> dict:
    """Per-metric signed contribution (+1 bullish / -1 bearish / 0 neutral) from
    the OCR'd features. Mirrors the on-chart BD SC calc; used as fallback + QA."""
    def side_pt(s: str | None) -> int:
        return 1 if s == "A" else -1 if s == "B" else 0

    if f["buy_pct"] is None:
        vol = 0
    elif f["buy_pct"] >= cfg["BUY_PCT_MIN"]:
        vol = 1
    elif f["buy_pct"] <= 100 - cfg["BUY_PCT_MIN"]:
        vol = -1
    else:
        vol = 0

    tick_bal = f["tick"] or 0
    tick = 1 if tick_bal > 0 else -1 if tick_bal < 0 else 0

    # Prefer the on-chart decision letter (precise) over comparing rounded ints.
    ss = f.get("stoch_side")
    if ss in ("A", "B"):
        stoch = 1 if ss == "A" else -1
    elif f["stoch_k"] is not None and f["stoch_d"] is not None:
        stoch = 1 if f["stoch_k"] > f["stoch_d"] else -1 if f["stoch_k"] < f["stoch_d"] else 0
    else:
        stoch = 0

    return {
        "rev":   1 if f["rv_dir"] == "U" else -1 if f["rv_dir"] == "D" else 0,
        "atr":   side_pt(f["atr_side"]),
        "vwap":  side_pt(f["vwap_side"]),
        "vol":   vol,
        "tick":  tick,
        "stoch": stoch,
    }


def evaluate(f: dict, list_dir: str, cfg: dict) -> dict:
    """Score a ticker for its universe's direction. The on-chart BD SC score is
    authoritative; the feature recompute is a fallback + cross-check.
    Bull list alerts at score>=+ALERT_MIN; bear list at score<=-ALERT_MIN."""
    parts = compute_parts(f, cfg)
    computed = sum(parts.values())
    onchart = f.get("score")
    score = onchart if onchart is not None else computed

    if list_dir == "bull":
        direction, alert = "LONG", score >= cfg["ALERT_MIN"]
    else:
        direction, alert = "SHORT", score <= -cfg["ALERT_MIN"]

    return {
        "direction": direction, "list_dir": list_dir,
        "score": score, "onchart_score": onchart, "computed_score": computed,
        "score_mismatch": onchart is not None and onchart != computed,
        "parts": parts, "alert": alert,
    }


# ─── Finviz ──────────────────────────────────────────────────────────────────
def finviz_to_export_url(screener_url: str) -> str:
    parsed = urllib.parse.urlparse(screener_url)
    return urllib.parse.urlunparse(parsed._replace(path="/export.ashx"))


def fetch_finviz_tickers(screener_url: str) -> list[str]:
    if not FINVIZ_API_KEY:
        raise RuntimeError("FINVIZ_API_KEY not set")
    export_url = finviz_to_export_url(screener_url)
    sep = "&" if "?" in export_url else "?"
    full = f"{export_url}{sep}auth={FINVIZ_API_KEY}"
    req = urllib.request.Request(full, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    })
    resp = urllib.request.urlopen(req, timeout=60)
    text = resp.read().decode("utf-8", errors="replace").lstrip("﻿")
    if text.lstrip().startswith("<") or "login" in text[:500].lower():
        raise RuntimeError("Finviz returned HTML/login redirect — check FINVIZ_API_KEY")
    reader = csv.DictReader(io.StringIO(text))
    tickers: list[str] = []
    for row in reader:
        sym = (row.get("Ticker") or row.get("ticker") or "").strip().upper()
        if sym and re.match(r"^[A-Z][A-Z0-9.\-]{0,6}$", sym):
            tickers.append(sym)
    return tickers


# ─── Window automation ───────────────────────────────────────────────────────
def list_tos_chart_windows() -> list[tuple[int, str]]:
    if not HAVE_WIN_AUTOMATION:
        raise RuntimeError("pywin32/pyautogui not installed — pip install pywin32 pyautogui")
    found: list[tuple[int, str]] = []
    def cb(hwnd: int, _arg: int) -> bool:
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        if title and "thinkorswim" in title.lower() and "charts" in title.lower():
            found.append((hwnd, title))
        return True
    win32gui.EnumWindows(cb, 0)
    return found


def find_scanner_window(title_match: str) -> tuple[int, str] | None:
    if not title_match:
        return None
    target_lower = title_match.lower()
    for hwnd, title in list_tos_chart_windows():
        if target_lower in title.lower():
            return (hwnd, title)
    return None


def pick_scanner_window_interactively() -> tuple[int, str] | None:
    candidates = list_tos_chart_windows()
    if not candidates:
        print("No TOS Charts windows found. Open a chart first.")
        return None
    print("\nAvailable TOS chart windows:")
    for i, (hwnd, title) in enumerate(candidates):
        print(f"  [{i}] hwnd {hwnd}  |  {title}")
    print("  [c] cancel")
    while True:
        choice = input("\nPick the chart to use as the Scanner: ").strip().lower()
        if choice == "c":
            return None
        if choice.isdigit():
            idx = int(choice)
            if 0 <= idx < len(candidates):
                return candidates[idx]
        print("Invalid choice — enter a number from the list, or 'c' to cancel.")


def get_or_pick_scanner_window(state: dict) -> tuple[int, str] | None:
    saved = state.get("scanner_hwnd")
    if saved:
        live = {h: t for h, t in list_tos_chart_windows()}
        if saved in live:
            print(f"Using saved scanner window hwnd {saved}: {live[saved]}")
            return (saved, live[saved])
        print(f"Saved hwnd {saved} no longer exists (TOS restart?) — re-picking.")
    if TOS_SCANNER_WINDOW:
        match = find_scanner_window(TOS_SCANNER_WINDOW)
        if match:
            return match
    if not sys.stdin.isatty():
        print("ERROR: no saved/matching window and not running interactively.")
        print("       Run once from a terminal to pick the scanner chart, then schedule.")
        return None
    return pick_scanner_window_interactively()


def focus_window(hwnd: int) -> None:
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        pyautogui.keyDown("alt")
        pyautogui.keyUp("alt")
        win32gui.SetForegroundWindow(hwnd)
    except Exception as e:
        print(f"  WARN: focus failed: {e}", file=sys.stderr)


def load_ticker_in_tos(hwnd: int, ticker: str) -> None:
    focus_window(hwnd)
    time.sleep(0.15)
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.10)
    pyautogui.typewrite(ticker, interval=KEY_INTERVAL_S)
    time.sleep(0.05)
    pyautogui.press("enter")


def capture_window(hwnd: int, out_path: Path) -> bool:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    ps = '''
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class WC {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
    public static void Cap(IntPtr h, string p) {
        RECT r; GetWindowRect(h, out r);
        int w = r.R - r.L, ht = r.B - r.T;
        var b = new Bitmap(w, ht);
        var g = Graphics.FromImage(b);
        var dc = g.GetHdc();
        PrintWindow(h, dc, 2);
        g.ReleaseHdc(dc); g.Dispose();
        b.Save(p, ImageFormat.Png); b.Dispose();
    }
}
"@ -ReferencedAssemblies System.Drawing
[WC]::Cap([IntPtr]''' + str(hwnd) + ''', "''' + str(out_path).replace("\\", "\\\\") + '''")
'''
    res = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-Command", ps],
        capture_output=True, text=True, timeout=30,
    )
    return res.returncode == 0 and out_path.exists() and out_path.stat().st_size > 10_000


# ─── Market hours gate ──────────────────────────────────────────────────────
def is_market_hours_pt() -> bool:
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    minutes_of_day = now.hour * 60 + now.minute
    return MARKET_OPEN_PT_MIN <= minutes_of_day <= MARKET_CLOSE_PT_MIN


# ─── State persistence (per-day, per-direction dedup) ───────────────────────
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"date": "", "alerted_today": []}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ─── Alert dispatch ─────────────────────────────────────────────────────────
def _parts_line(parts: dict) -> str:
    order = ["rev", "atr", "vwap", "vol", "tick", "stoch"]
    sym = lambda v: "+" if v > 0 else "-" if v < 0 else "0"
    return " ".join(f"{k}{sym(parts[k])}" for k in order)


def send_pushover(ticker: str, scored: dict, f: dict) -> bool:
    if not (PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN):
        print("  WARN: skipping Pushover (keys missing)", file=sys.stderr)
        return False
    msg = (
        f"score {scored['score']:+d} ({scored['direction']})\n"
        f"{_parts_line(scored['parts'])}\n"
        f"REV {f.get('rv_dir') or '?'} buy%={f.get('buy_pct')} "
        f"tick={f.get('tick')} stoch={f.get('stoch_k')}/{f.get('stoch_d')} "
        f"vwap={f.get('vwap_side')} atr={f.get('atr_side')}"
    )
    body = urllib.parse.urlencode({
        "token": PUSHOVER_APP_TOKEN,
        "user": PUSHOVER_USER_KEY,
        "title": f"BIGDOG {scored['direction']} {scored['score']:+d}: {ticker}",
        "message": msg,
        "priority": "1" if abs(scored["score"]) >= 5 else "0",
    }).encode()
    req = urllib.request.Request("https://api.pushover.net/1/messages.json", data=body)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status == 200
    except Exception as e:
        print(f"  ERROR: Pushover send failed: {e}", file=sys.stderr)
        return False


def enqueue_whatsapp(ticker: str, scored: dict, f: dict) -> bool:
    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if not conn or not RECEIVER:
        print("  WARN: skipping WhatsApp (conn or receiver missing)", file=sys.stderr)
        return False
    try:
        from azure.storage.queue import QueueClient
    except ImportError:
        print("  WARN: azure-storage-queue not installed", file=sys.stderr)
        return False
    arrow = "\U0001f7e2" if scored["direction"] == "LONG" else "\U0001f534"
    text = (
        f"{arrow} BIGDOG {scored['direction']} {scored['score']:+d} — {ticker}\n"
        f"{_parts_line(scored['parts'])}\n"
        f"REV {f.get('rv_dir') or '?'}  buy%={f.get('buy_pct')}  stoch={f.get('stoch_k')}/{f.get('stoch_d')}"
    )
    payload = {
        "to": RECEIVER,
        "text": text,
        "meta": {"ticker": ticker, "source": "bigdog", "score": scored["score"]},
    }
    body = base64.b64encode(json.dumps(payload).encode()).decode()
    try:
        q = QueueClient.from_connection_string(conn, QUEUE_NAME)
        try:
            q.create_queue()
        except Exception:
            pass
        q.send_message(body)
        return True
    except Exception as e:
        print(f"  ERROR: queue send failed: {e}", file=sys.stderr)
        return False


def post_to_portal(ticker: str, scored: dict, f: dict, cfg: dict) -> bool:
    if not TIMER_SECRET:
        print("  WARN: TIMER_SECRET missing, skipping portal log", file=sys.stderr)
        return False
    ocr_misses = [k for k in ("vwap_side", "atr_side", "buy_pct", "tick", "stoch_k", "score") if f.get(k) is None]
    body = json.dumps({
        "ticker": ticker,
        "system": "bigdog",
        "direction": scored["direction"],
        "listDir": scored["list_dir"],
        "score": scored["score"],
        "onchartScore": scored["onchart_score"],
        "computedScore": scored["computed_score"],
        "scoreMismatch": scored["score_mismatch"],
        "alertMin": cfg["ALERT_MIN"],
        "parts": scored["parts"],
        "raw": {
            "rv_dir": f.get("rv_dir"), "rv_bars": f.get("rv_bars"),
            "rv_price": f.get("rv_price"), "rv_time": f.get("rv_time"), "rv_date": f.get("rv_date"),
            "trend": f.get("trend"),
            "buy_pct": f.get("buy_pct"),
            "sell_pct": (100 - f["buy_pct"]) if f.get("buy_pct") is not None else None,
            "tick_bal": f.get("tick"),
            "stoch_k": f.get("stoch_k"), "stoch_d": f.get("stoch_d"), "stoch_side": f.get("stoch_side"),
            "vwap_side": f.get("vwap_side"), "vwap": f.get("vwap"),
            "atr_side": f.get("atr_side"), "atr": f.get("atr"),
        },
        "thresholds": {"buy_pct_min": cfg["BUY_PCT_MIN"], "alert_min": cfg["ALERT_MIN"]},
        "ocr_misses": ocr_misses,
        "ts": datetime.now(timezone.utc).isoformat(),
        "source": "bigdog-ocr",
    }).encode()
    req = urllib.request.Request(
        f"{API_BASE}/api/bigdog-alert",
        data=body,
        headers={"Content-Type": "application/json", "x-timer-secret": TIMER_SECRET},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status == 200
    except Exception as e:
        print(f"  ERROR: portal POST failed: {e}", file=sys.stderr)
        return False


# ─── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="OCR + score but don't alert")
    parser.add_argument("--force",   action="store_true", help="ignore market-hours gate")
    parser.add_argument("--max", type=int, default=0, help="limit to N tickers (debug)")
    parser.add_argument("--show-text", action="store_true", help="print raw OCR + features per ticker")
    parser.add_argument("--pick-window", action="store_true",
                        help="force re-selection of the scanner chart (clears the saved hwnd)")
    args = parser.parse_args()

    print(f"=== BigDog Scanner — {datetime.now():%Y-%m-%d %H:%M:%S} ===")
    cfg = load_cfg()

    if not args.force and not is_market_hours_pt():
        print(f"Outside market hours (PT {MARKET_OPEN_PT_MIN//60:02d}:{MARKET_OPEN_PT_MIN%60:02d}"
              f"–{MARKET_CLOSE_PT_MIN//60:02d}:{MARKET_CLOSE_PT_MIN%60:02d}, weekdays). "
              f"Use --force to bypass.")
        return 0

    if not (FINVIZ_SCREENER_URL_BULL or FINVIZ_SCREENER_URL_BEAR):
        print("ERROR: set FINVIZ_SCREENER_URL_BULL and/or FINVIZ_SCREENER_URL_BEAR")
        return 1
    if not HAVE_WIN_AUTOMATION:
        print("ERROR: pip install pyautogui pywin32 azure-storage-queue python-dotenv")
        return 1

    state = load_state()
    today = datetime.now().strftime("%Y-%m-%d")
    if state.get("date") != today:
        state = {"date": today, "alerted_today": [], "scanner_hwnd": state.get("scanner_hwnd")}
    if args.pick_window:
        state["scanner_hwnd"] = None
    alerted_today = set(state["alerted_today"])   # keys: "TICKER:DIRECTION"

    found = get_or_pick_scanner_window(state)
    if not found:
        return 3
    hwnd, title = found
    if state.get("scanner_hwnd") != hwnd:
        state["scanner_hwnd"] = hwnd
        save_state(state)
        print(f"Saved scanner window for future runs: hwnd {hwnd}")
    print(f"Scanner window: '{title}' (hwnd {hwnd})")

    universes: list[tuple[str, str]] = []
    if FINVIZ_SCREENER_URL_BULL:
        universes.append(("bull", FINVIZ_SCREENER_URL_BULL))
    if FINVIZ_SCREENER_URL_BEAR:
        universes.append(("bear", FINVIZ_SCREENER_URL_BEAR))

    fired_count = 0
    scanned = 0
    for list_dir, url in universes:
        print(f"\n--- {list_dir.upper()} universe ---")
        try:
            tickers = fetch_finviz_tickers(url)
        except Exception as e:
            print(f"ERROR: Finviz fetch failed ({list_dir}): {e}")
            continue
        if args.max:
            tickers = tickers[:args.max]
        print(f"Got {len(tickers)} tickers: {', '.join(tickers[:10])}{'…' if len(tickers) > 10 else ''}")

        for i, ticker in enumerate(tickers):
            print(f"[{list_dir} {i+1}/{len(tickers)}] {ticker} …", end=" ", flush=True)
            scanned += 1

            load_ticker_in_tos(hwnd, ticker)
            time.sleep(LOAD_WAIT_S)

            cap_path = WORKSPACE / f"scan_{ticker}.png"
            if not capture_window(hwnd, cap_path):
                print("CAPTURE FAILED")
                continue

            try:
                lines = run_ocr(crop_strip(cap_path))
                f = parse_bigdog_strip(lines)
            except Exception as e:
                print(f"OCR ERROR: {e}")
                continue

            if args.show_text:
                print(f"\n  raw: {lines}\n  feat: {f}")

            scored = evaluate(f, list_dir, cfg)
            mism = " !score-mismatch" if scored["score_mismatch"] else ""
            tag = (f"{scored['direction']} score {scored['score']:+d} "
                   f"[{_parts_line(scored['parts'])}]{mism}")

            if not scored["alert"]:
                print(f"no alert — {tag}")
                continue

            dedup_key = f"{ticker}:{scored['direction']}"
            if dedup_key in alerted_today:
                print(f"{tag} (already alerted today)")
                continue

            print(f"ALERT {tag}")
            if args.dry_run:
                print("  (dry-run: would alert)")
                continue

            wa_ok = enqueue_whatsapp(ticker, scored, f)
            portal_ok = post_to_portal(ticker, scored, f, cfg)
            po_ok = send_pushover(ticker, scored, f) if ENABLE_PUSHOVER else False
            if wa_ok or portal_ok or po_ok:
                alerted_today.add(dedup_key)
                fired_count += 1
                print(f"  sent: whatsapp={wa_ok} portal={portal_ok} pushover={po_ok}")

    state["alerted_today"] = sorted(alerted_today)
    save_state(state)

    print(f"\n=== Scan complete: {scanned} tickers, {fired_count} new alerts ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
