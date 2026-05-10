"""
Finviz → TOS → OCR → WhatsApp scanner.

Pulls a Finviz Elite screener export, loads each ticker into a dedicated TOS
chart window via keyboard automation, OCRs the Azhar_Reversal label strip we
designed, and alerts (WhatsApp + portal) on fresh up-reversals.

Trust-preserving: the reversal signal comes off the actual TOS chart your
Azhar_Reversal study draws — no server-side ZigZag re-derivation.

Workflow per scan cycle:
  1. Gate: skip if outside market hours (default 6:30 AM – 1:00 PM PT, weekdays).
  2. Pull Finviz screener export → list of tickers.
  3. Find dedicated TOS scanner chart window (config: TOS_SCANNER_WINDOW).
  4. For each ticker:
     a. SetForegroundWindow(scanner) → Ctrl+L → type ticker → Enter
     b. Wait ~LOAD_WAIT_S for chart to repaint
     c. PowerShell PrintWindow capture
     d. Crop top 8% → RapidOCR → regex parse
     e. If reversal.direction == "U" AND rev_time within FRESH_MINUTES of now
        AND not already alerted today:
          - Enqueue WhatsApp via Azure Storage Queue (sidecar drains)
          - POST to /api/scanner-alert (logs to AlertLog → Day Trades page)

Required env vars (read from .env in this directory or process env):
  FINVIZ_API_KEY                       Finviz Elite auth token
  AZURE_STORAGE_CONNECTION_STRING      For whatsapp-alerts queue
  WHATSAPP_QUEUE_NAME                  Default: whatsapp-alerts
  WHATSAPP_RECEIVER                    E.164 (no '+'), e.g. "14253241733"
  TIMER_SECRET                         For POST to /api/scanner-alert
  SCANNER_API_BASE                     Default: https://salmon-river-0a7a0c30f.1.azurestaticapps.net
  TOS_SCANNER_WINDOW                   Substring match for the dedicated chart window title
  FINVIZ_SCREENER_URL                  Finviz Elite screener URL (any v= variant)

Usage:
  python finviz_scanner.py             # one full scan cycle (Task Scheduler entry point)
  python finviz_scanner.py --dry-run   # OCR + decisioning, but no alerts
  python finviz_scanner.py --max 5     # limit to first 5 tickers (debug)
  python finviz_scanner.py --force     # ignore market-hours gate
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

# Best-effort .env load — falls back to process env if python-dotenv isn't installed.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

# Windows automation — only required at runtime, not import time so unit tests
# of the parser still work on non-Windows.
try:
    import pyautogui
    import win32gui
    import win32con
    HAVE_WIN_AUTOMATION = True
except ImportError:
    HAVE_WIN_AUTOMATION = False

# ─── Config ──────────────────────────────────────────────────────────────────
FRESH_MINUTES = int(os.environ.get("SCANNER_FRESH_MINUTES", "10"))
LOAD_WAIT_S   = float(os.environ.get("SCANNER_LOAD_WAIT_S", "2.0"))
KEY_INTERVAL_S = float(os.environ.get("SCANNER_KEY_INTERVAL_S", "0.025"))
MARKET_OPEN_PT_MIN  = 6 * 60 + 30   # 6:30 AM PT
MARKET_CLOSE_PT_MIN = 13 * 60       # 1:00 PM PT (regular session close)
STATE_FILE = Path(__file__).parent / ".state" / "scanner_state.json"
WORKSPACE = Path(__file__).parent / ".state" / "captures"

API_BASE = os.environ.get("SCANNER_API_BASE",
                          "https://salmon-river-0a7a0c30f.1.azurestaticapps.net")
QUEUE_NAME = os.environ.get("WHATSAPP_QUEUE_NAME", "whatsapp-alerts")
RECEIVER = os.environ.get("WHATSAPP_RECEIVER", "")
TIMER_SECRET = os.environ.get("TIMER_SECRET", "")
TOS_SCANNER_WINDOW = os.environ.get("TOS_SCANNER_WINDOW", "")
FINVIZ_API_KEY = os.environ.get("FINVIZ_API_KEY", "")
FINVIZ_SCREENER_URL = os.environ.get("FINVIZ_SCREENER_URL", "")

STRIP_PCT = 0.08

# ─── OCR pipeline (mirror of test_ocr.py) ────────────────────────────────────
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


_TREND_RE = re.compile(r"\bTREND\s*(UP|DN|FLAT)\b", re.IGNORECASE)
_REV_RE = re.compile(
    r"\bREV\s*(?P<dir>[UD])\s*[\$S]?\s*(?P<price>\d+\.\d{2})\s*"
    r"(?P<date>\d{1,2}/\d{1,2})\s*"
    r"(?P<time>\d{2}:\d{2})\s*"
    r"(?P<bars>\d+)\s*[bB]\b",
    re.IGNORECASE,
)
_TICKER_RE = re.compile(r"^([A-Z]{1,6})(?=\d|\s|[^A-Z]|$)")


def parse_strip(lines: list[str]) -> dict:
    blob = " ".join(lines)
    out: dict = {
        "ticker": None, "trend": None,
        "reversal": {"direction": None, "price": None, "date": None, "time": None, "bars_ago": None},
    }
    if lines and (m := _TICKER_RE.match(lines[0].strip())):
        out["ticker"] = m.group(1)
    if (m := _TREND_RE.search(blob)):
        out["trend"] = m.group(1).upper()
    if (m := _REV_RE.search(blob)):
        out["reversal"] = {
            "direction": m.group("dir").upper(),
            "price":     float(m.group("price")),
            "date":      m.group("date"),
            "time":      m.group("time"),
            "bars_ago":  int(m.group("bars")),
        }
    return out


# ─── Finviz ──────────────────────────────────────────────────────────────────
def finviz_to_export_url(screener_url: str) -> str:
    """Convert a /screener URL to the matching /export.ashx URL preserving filters."""
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
    """Return every visible TOS Charts window as (hwnd, title)."""
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
    """Title-substring match — used when TOS_SCANNER_WINDOW is set and matches."""
    if not title_match:
        return None
    target_lower = title_match.lower()
    for hwnd, title in list_tos_chart_windows():
        if target_lower in title.lower():
            return (hwnd, title)
    return None


def pick_scanner_window_interactively() -> tuple[int, str] | None:
    """Show all chart windows and let the user pick one. Returns chosen
    (hwnd, title) or None if no candidates / user cancelled."""
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
    """Resolve the scanner window in this priority order:
       1. Saved hwnd from state file (if still a live TOS Charts window).
       2. TOS_SCANNER_WINDOW substring match (if env var set).
       3. Interactive picker (TTY only).
    Returns (hwnd, title) or None."""
    # 1. Saved hwnd
    saved = state.get("scanner_hwnd")
    if saved:
        live = {h: t for h, t in list_tos_chart_windows()}
        if saved in live:
            print(f"Using saved scanner window hwnd {saved}: {live[saved]}")
            return (saved, live[saved])
        print(f"Saved hwnd {saved} no longer exists (TOS restart?) — re-picking.")

    # 2. Title-substring match (env var)
    if TOS_SCANNER_WINDOW:
        match = find_scanner_window(TOS_SCANNER_WINDOW)
        if match:
            return match

    # 3. Interactive picker — only useful if a human is at the terminal.
    if not sys.stdin.isatty():
        print("ERROR: no saved/matching window and not running interactively.")
        print("       Run once from a terminal to pick the scanner chart, then schedule.")
        return None

    return pick_scanner_window_interactively()


def focus_window(hwnd: int) -> None:
    """Bring TOS chart window to foreground. Sometimes Windows blocks
    SetForegroundWindow if the calling process doesn't own foreground —
    workaround is the alt-key trick used by pyautogui internally."""
    try:
        # Restore if minimized.
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        # Alt key release nudges foreground permission on Win11.
        pyautogui.keyDown("alt")
        pyautogui.keyUp("alt")
        win32gui.SetForegroundWindow(hwnd)
    except Exception as e:
        print(f"  WARN: focus failed: {e}", file=sys.stderr)


def load_ticker_in_tos(hwnd: int, ticker: str) -> None:
    """Send Ctrl+L then ticker + Enter to the focused TOS chart."""
    focus_window(hwnd)
    time.sleep(0.15)
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.10)
    pyautogui.typewrite(ticker, interval=KEY_INTERVAL_S)
    time.sleep(0.05)
    pyautogui.press("enter")


def capture_window(hwnd: int, out_path: Path) -> bool:
    """Use the same PowerShell PrintWindow trick as tos_monitor.py."""
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


# ─── Freshness check ─────────────────────────────────────────────────────────
def rev_minutes_ago(rev_time_str: str) -> int | None:
    """Given 'HH:MM' from the OCR label (in local PT clock), return minutes
    since now. Returns None if unparseable. Wraps if rev is from a future
    minute (clock skew)."""
    m = re.match(r"^(\d{1,2}):(\d{2})$", rev_time_str)
    if not m:
        return None
    rev_h, rev_m = int(m.group(1)), int(m.group(2))
    now = datetime.now()
    rev_total = rev_h * 60 + rev_m
    now_total = now.hour * 60 + now.minute
    diff = now_total - rev_total
    if diff < 0:
        diff += 24 * 60  # rolled past midnight
    return diff


# ─── Market hours gate ──────────────────────────────────────────────────────
def is_market_hours_pt() -> bool:
    now = datetime.now()
    if now.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    minutes_of_day = now.hour * 60 + now.minute
    return MARKET_OPEN_PT_MIN <= minutes_of_day <= MARKET_CLOSE_PT_MIN


# ─── State persistence (per-day dedup) ──────────────────────────────────────
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
def enqueue_whatsapp(ticker: str, parsed: dict) -> bool:
    """Push base64-JSON message into the Azure Storage Queue the sidecar drains."""
    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if not conn or not RECEIVER:
        print(f"  WARN: skipping WhatsApp (conn or receiver missing)", file=sys.stderr)
        return False
    try:
        from azure.storage.queue import QueueClient
    except ImportError:
        print(f"  WARN: azure-storage-queue not installed", file=sys.stderr)
        return False

    rev = parsed["reversal"]
    text = (
        f"\U0001f7e2 {ticker} REVERSAL UP @ ${rev['price']}\n"
        f"\U0001f550 {rev['date']} {rev['time']} ({rev['bars_ago']} bars ago)\n"
        f"\U0001f4ca Trend {parsed.get('trend') or '?'}"
    )
    payload = {
        "to": RECEIVER,
        "text": text,
        "meta": {"ticker": ticker, "source": "finviz", "rev": rev},
    }
    body = base64.b64encode(json.dumps(payload).encode()).decode()
    try:
        q = QueueClient.from_connection_string(conn, QUEUE_NAME)
        try:
            q.create_queue()
        except Exception:
            pass  # already exists
        q.send_message(body)
        return True
    except Exception as e:
        print(f"  ERROR: queue send failed: {e}", file=sys.stderr)
        return False


def post_to_portal(ticker: str, parsed: dict, status: str) -> bool:
    if not TIMER_SECRET:
        print(f"  WARN: TIMER_SECRET missing, skipping portal log", file=sys.stderr)
        return False
    rev = parsed["reversal"]
    body = json.dumps({
        "ticker": ticker,
        "reversalPrice": rev["price"],
        "revTime": f"{rev['date']} {rev['time']}",
        "source": "finviz",
        "status": status,
    }).encode()
    req = urllib.request.Request(
        f"{API_BASE}/api/scanner-alert",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-timer-secret": TIMER_SECRET,
        },
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
    parser.add_argument("--dry-run", action="store_true", help="OCR + decide but don't alert")
    parser.add_argument("--force",   action="store_true", help="ignore market-hours gate")
    parser.add_argument("--max", type=int, default=0, help="limit to N tickers (debug)")
    parser.add_argument("--show-text", action="store_true", help="print raw OCR per ticker")
    parser.add_argument("--pick-window", action="store_true",
                        help="force re-selection of the scanner chart (clears the saved hwnd)")
    args = parser.parse_args()

    print(f"=== Finviz Scanner — {datetime.now():%Y-%m-%d %H:%M:%S} ===")

    if not args.force and not is_market_hours_pt():
        print(f"Outside market hours (PT {MARKET_OPEN_PT_MIN//60:02d}:{MARKET_OPEN_PT_MIN%60:02d}"
              f"–{MARKET_CLOSE_PT_MIN//60:02d}:{MARKET_CLOSE_PT_MIN%60:02d}, weekdays). "
              f"Use --force to bypass.")
        return 0

    if not FINVIZ_SCREENER_URL:
        print("ERROR: FINVIZ_SCREENER_URL env var not set")
        return 1
    if not HAVE_WIN_AUTOMATION:
        print("ERROR: pip install pyautogui pywin32 azure-storage-queue python-dotenv")
        return 1

    # Load state first so we can recover the saved scanner hwnd before any work.
    state = load_state()
    today = datetime.now().strftime("%Y-%m-%d")
    if state.get("date") != today:
        # New trading day — reset per-day dedup but keep the saved hwnd.
        state = {
            "date": today,
            "alerted_today": [],
            "scanner_hwnd": state.get("scanner_hwnd"),
        }
    if args.pick_window:
        state["scanner_hwnd"] = None
    alerted_today = set(state["alerted_today"])

    found = get_or_pick_scanner_window(state)
    if not found:
        return 3
    hwnd, title = found
    if state.get("scanner_hwnd") != hwnd:
        state["scanner_hwnd"] = hwnd
        save_state(state)
        print(f"Saved scanner window for future runs: hwnd {hwnd}")
    print(f"Scanner window: '{title}' (hwnd {hwnd})")

    print(f"Pulling Finviz screener…")
    try:
        tickers = fetch_finviz_tickers(FINVIZ_SCREENER_URL)
    except Exception as e:
        print(f"ERROR: Finviz fetch failed: {e}")
        return 2
    if args.max:
        tickers = tickers[:args.max]
    print(f"Got {len(tickers)} tickers: {', '.join(tickers[:10])}{'…' if len(tickers) > 10 else ''}")

    fired_count = 0
    for i, ticker in enumerate(tickers):
        print(f"[{i+1}/{len(tickers)}] {ticker} …", end=" ", flush=True)
        if ticker in alerted_today:
            print("(already alerted today)")
            continue

        load_ticker_in_tos(hwnd, ticker)
        time.sleep(LOAD_WAIT_S)

        cap_path = WORKSPACE / f"scan_{ticker}.png"
        if not capture_window(hwnd, cap_path):
            print("CAPTURE FAILED")
            continue

        try:
            cropped = crop_strip(cap_path)
            lines = run_ocr(cropped)
            parsed = parse_strip(lines)
        except Exception as e:
            print(f"OCR ERROR: {e}")
            continue

        if args.show_text:
            print(f"\n  raw: {lines}")

        rev = parsed["reversal"]
        if rev["direction"] != "U":
            print(f"no UP reversal (dir={rev['direction']})")
            continue

        mins_ago = rev_minutes_ago(rev["time"]) if rev["time"] else None
        if mins_ago is None or mins_ago > FRESH_MINUTES:
            print(f"REV U @ {rev['time']} but {mins_ago} min ago > {FRESH_MINUTES} threshold — stale")
            continue

        # FRESH up-reversal → alert
        print(f"FRESH REV U @ ${rev['price']} ({mins_ago} min ago)")
        if args.dry_run:
            print(f"  (dry-run: would alert)")
            continue

        wa_ok = enqueue_whatsapp(ticker, parsed)
        portal_ok = post_to_portal(ticker, parsed, "WHATSAPP" if wa_ok else "WHATSAPP_FAILED")
        if wa_ok or portal_ok:
            alerted_today.add(ticker)
            fired_count += 1
            print(f"  alerted: whatsapp={wa_ok} portal={portal_ok}")

    state["alerted_today"] = sorted(alerted_today)
    save_state(state)

    print(f"\n=== Scan complete: {len(tickers)} tickers, {fired_count} new alerts ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
