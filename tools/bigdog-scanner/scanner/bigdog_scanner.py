"""
BigDog Trades — TOS watchlists → OCR → fresh-reversal → options alert scanner.

Source = two on-screen TOS watchlists (Puts + Calls). Per cycle the scanner
identifies the two watchlist windows (Calls/Puts by OCRing the tab), reads each
Symbol column, and clicks each row — TOS symbol-linking loads that OPTION's chart
into the shared Charts window (no typing). It OCRs the reversal study's label
strip and alerts on the option's own FRESH bullish reversal, via WhatsApp
(Pushover opt-in) + the MTF portal. Finviz/score/DTSWAI-regime were removed
2026-07-24 — the watchlist is the sole source and there is no score.

Reversal-study strip fields (docs/thinkscript-ocr.tos):
  TREND UP/DN/FLAT · REV U/D $price M/D HH:MM Nb · BUY $price Nb · SL $price · RISK <pct>%

Trigger: a FRESH reversal of the option in EITHER direction (REV U or D) AND
rv_bars <= WATCHLIST_REV_MAX_BARS (just-closed 5-min bar). No score gate. The cloud
routes: revDir U → enter, D → exit (if held). side = CALL|PUT = which list. Dedup
key SYMBOL:SIDE:REVDIR, once/calendar-day (U and D on the same option both send).

Alert payload (17-field options contract): symbol, side, system, source, revDir,
revBars, revPrice, revTime, revDate, trend, last, buy, sl, riskPct, putsCount,
callsCount, ts.  riskPct = (buy − sl·(1−slBufferPct/100))/buy·100.

Required env (.env in this dir or process env):
  AZURE_STORAGE_CONNECTION_STRING, WHATSAPP_QUEUE_NAME, WHATSAPP_RECEIVER
  TIMER_SECRET, SCANNER_API_BASE, TOS_SCANNER_WINDOW (the Charts window)
Tunable (defaults): ENABLE_PUSHOVER (false), TOS_WATCHLIST_WINDOW (Watchlist),
  WATCHLIST_CALLS_TAG (call), WATCHLIST_PUTS_TAG (put), WATCHLIST_REV_MAX_BARS (1),
  WATCHLIST_STRIP_PCT (0.22), SCANNER_SL_BUFFER_PCT (0.05), WATCHLIST_SCROLL (false),
  SCANNER_LOAD_WAIT_S, SCANNER_STRIP_PCT.

Usage:
  python bigdog_scanner.py                    # one scan cycle (Task Scheduler entry)
  python bigdog_scanner.py --dry-run          # click + OCR + gate, no alerts
  python bigdog_scanner.py --calibrate-watchlist  # dump detected symbols/click-points, no clicks
  python bigdog_scanner.py --max 5            # limit to 5 rows per list (debug)
  python bigdog_scanner.py --force            # ignore market-hours gate
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
    import ctypes
    import pyautogui
    import win32gui
    import win32con
    HAVE_WIN_AUTOMATION = True
except ImportError:
    HAVE_WIN_AUTOMATION = False


def _set_dpi_aware() -> None:
    """Make this process per-monitor DPI-aware so win32gui.GetWindowRect,
    PIL/pyautogui screenshots, and pyautogui mouse coordinates all agree in
    PHYSICAL pixels. Without this, on a scaled display (>100%) the coordinates
    a screenshot is measured in and the coordinates a click lands in diverge,
    so watchlist-row clicks miss. Safe/no-op at 100% scaling. Must run before
    any window measurement or mouse move."""
    if not HAVE_WIN_AUTOMATION:
        return
    try:
        # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Win10 1703+)
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

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
PUSHOVER_USER_KEY = os.environ.get("PUSHOVER_USER_KEY", "")
PUSHOVER_APP_TOKEN = os.environ.get("PUSHOVER_APP_TOKEN", "")
# WhatsApp is the primary channel; Pushover is opt-in (set ENABLE_PUSHOVER=true).
ENABLE_PUSHOVER = os.environ.get("ENABLE_PUSHOVER", "false").strip().lower() in ("1", "true", "yes", "on")

# Fraction of window height (from top) cropped for the OCR label strip. Tuned
# per-machine: on a detached Charts window with extra chrome (title/tab/quote/
# study-legend rows) the BigDog strip sits ~9% down, so 0.08 clips it. Override
# with SCANNER_STRIP_PCT if the strip lands elsewhere on your layout.
STRIP_PCT = float(os.environ.get("SCANNER_STRIP_PCT", "0.12"))

# ─── Watchlist config (the sole source — Finviz removed 2026-07-24) ──────────
# The scanner reads the two on-screen TOS watchlists (Puts/Calls), clicks each
# row to load its option chart, OCRs the reversal-study strip, and alerts on a
# FRESH bullish reversal of the option itself (see evaluate_watchlist).
# Substring matched against the watchlist window titles (both are literally
# "Watchlist Main@thinkorswim"; the Calls/Puts distinction comes from OCR).
TOS_WATCHLIST_WINDOW = os.environ.get("TOS_WATCHLIST_WINDOW", "Watchlist")
# Case-insensitive substrings used to tell the two watchlist windows apart by
# OCRing their tab strip.
WATCHLIST_CALLS_TAG = os.environ.get("WATCHLIST_CALLS_TAG", "call").strip().lower()
WATCHLIST_PUTS_TAG  = os.environ.get("WATCHLIST_PUTS_TAG", "put").strip().lower()
# A reversal counts as "in the last 5-min bar" when bars-since-reversal <= this.
WATCHLIST_REV_MAX_BARS = int(os.environ.get("WATCHLIST_REV_MAX_BARS", "1"))
# OCR-strip crop for the OPTION chart in watchlist mode. Larger than STRIP_PCT
# (0.12) on purpose: the BigDog label row sits at a fixed PIXEL offset below the
# toolbar (~8–15% of window height depending on how tall the chart window is),
# so a fixed 0.12 clips it whenever the window is shorter than when 0.12 was
# tuned. 0.22 reliably contains the label band across window sizes; the extra
# chart rows are ignored by the anchored REV/TREND/BD regexes.
WATCHLIST_STRIP_PCT = float(os.environ.get("WATCHLIST_STRIP_PCT", "0.22"))
# Slippage buffer widened BEYOND the chart stop when computing the Buy→Stop
# risk %. Must match the study's slBufferPct input. Used only as a fallback when
# the chart's RISK% chip isn't OCR'd (chart value wins when present).
SL_BUFFER_PCT = float(os.environ.get("SCANNER_SL_BUFFER_PCT", "0.05"))
# Whether the watchlists exceed one screen and must be scrolled. Default off:
# on DESKTOP2 both lists fit fully on screen, so the scanner reads one page and
# that IS the whole list. Set true only where a list is longer than the window
# (then it scrolls + de-dupes) — verify scrolling actually advances there first.
WATCHLIST_SCROLL = os.environ.get("WATCHLIST_SCROLL", "false").strip().lower() in ("1", "true", "yes", "on")
# Mouse-wheel notches per scroll-down step (only used when WATCHLIST_SCROLL).
# Kept small (< one page) so pages overlap and no row is skipped; overlap is
# deduped by symbol.
WATCHLIST_SCROLL_CLICKS = int(os.environ.get("WATCHLIST_SCROLL_CLICKS", "5"))
# Seconds to let a row-click's linked chart settle before the load-wait proper.
WATCHLIST_CLICK_SETTLE_S = float(os.environ.get("WATCHLIST_CLICK_SETTLE_S", "0.20"))
# Fallback left→right order of the watchlist windows if OCR can't read the tab.
WATCHLIST_FALLBACK_ORDER = [s.strip().upper() for s in
                            os.environ.get("WATCHLIST_FALLBACK_ORDER", "PUT,CALL").split(",")]


# ─── OCR pipeline ────────────────────────────────────────────────────────────
_engine = None
def _get_engine() -> RapidOCR:
    global _engine
    if _engine is None:
        _engine = RapidOCR()
    return _engine


def crop_strip(image_path: Path, strip_pct: float | None = None) -> np.ndarray:
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    pct = STRIP_PCT if strip_pct is None else strip_pct
    strip = img.crop((0, 0, w, int(h * pct)))
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

# TOS option-symbol as shown in a watchlist Symbol column, e.g. NVDA260731P210,
# NFLX260731C70, NVDA260731P207.5, GOOGL260821C320. Root(1-6) + YYMMDD + C|P +
# strike(+optional .frac). `search` (not fullmatch) tolerates a stray OCR prefix.
_OPT_SYM_RE = re.compile(r"[A-Z]{1,6}\d{6}[CP]\d+(?:\.\d+)?")

# Azhar reversal-study trade levels (the study drawn on the OPTION charts):
# BUY $price Nb · SL $price · TP $price · R <ratio>. The '$' frequently OCRs as
# 'S'. R is the reward/risk ratio as a bare "R<num>" — distinct from the chart's
# own "R:<num>" range quote field (the colon in "R:" guards against a false match).
_BUY_RE = re.compile(r"\bBUY\s*[\$S]?\s*(\d+\.\d{2})\s*(\d+)\s*[bB]\b", re.IGNORECASE)
_SL_RE  = re.compile(r"\bSL\s*[\$S]?\s*(\d+\.\d{2})", re.IGNORECASE)
# RISK <pct>%  — Buy→Stop distance as % of entry (with slBufferPct buffer).
# TP and R chips were removed from the study (TP is dynamic) — no longer parsed.
_RISK_RE = re.compile(r"\bRISK\s*(\d+\.\d+)\s*%", re.IGNORECASE)


def parse_bigdog_strip(lines: list[str]) -> dict:
    """Parse the consolidated BigDog_OCR strip into raw features. Any missing
    chip is left None — itself a QA/research signal (OCR miss vs genuinely absent)."""
    blob = " ".join(lines)
    f: dict = {
        "ticker": None,
        "last": None,          # option's current price (TODO: from watchlist Last column)
        "rv_dir": None, "rv_bars": None, "rv_price": None, "rv_date": None, "rv_time": None,
        "trend": None,
        "vwap_side": None, "vwap": None,
        "atr_side": None, "atr": None,
        "buy_pct": None,
        "tick": None,          # day green-red histogram-bar balance (signed)
        "stoch_k": None, "stoch_d": None, "stoch_side": None,  # side = A(K>D)/B(K<D)
        "score": None,         # on-chart signed composite score (BD SC), -6..+6
        # Azhar reversal-study trade levels (present on the OPTION charts).
        # risk_pct = Buy→Stop distance (%). TP/R chips removed from the study.
        "buy_price": None, "buy_bars": None, "sl": None, "risk_pct": None,
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
    # Reversal-study trade levels (options charts).
    if (m := _BUY_RE.search(blob)):
        f["buy_price"] = float(m.group(1))
        f["buy_bars"]  = int(m.group(2))
    if (m := _SL_RE.search(blob)):
        f["sl"] = float(m.group(1))
    # Buy→Stop risk %. Prefer the chart's RISK chip (chart-truth); otherwise
    # compute it from BUY/SL with the same slBufferPct buffer beyond the stop.
    if (m := _RISK_RE.search(blob)):
        f["risk_pct"] = float(m.group(1))
    elif f["buy_price"] and f["sl"] and f["buy_price"] > 0:
        sl_buffered = f["sl"] * (1 - SL_BUFFER_PCT / 100.0)
        f["risk_pct"] = round((f["buy_price"] - sl_buffered) / f["buy_price"] * 100, 2)
    return f


# ─── Alert gate (options: fresh bullish reversal only) ───────────────────────
def evaluate_watchlist(f: dict, kind: str) -> dict:
    """Fire on a FRESH reversal of the option in EITHER direction on the just-closed
    bar (rv_bars <= WATCHLIST_REV_MAX_BARS). `revDir` U = bullish (cloud → entry),
    D = bearish (cloud → exit if held); the cloud holds state and routes. No score.
    `kind` is 'CALL' or 'PUT' (which list the row is on) = the alert `side`."""
    rb = f.get("rv_bars")
    fresh_rev = (f.get("rv_dir") in ("U", "D")) and (rb is not None and rb <= WATCHLIST_REV_MAX_BARS)
    return {"direction": kind, "list_dir": kind.lower(), "alert": fresh_rev}


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


# ─── Watchlist automation (the sole source) ──────────────────────────────────
def list_tos_watchlist_windows() -> list[tuple[int, str]]:
    """Visible top-level TOS windows whose title marks them as watchlists."""
    if not HAVE_WIN_AUTOMATION:
        raise RuntimeError("pywin32/pyautogui not installed — pip install pywin32 pyautogui")
    match = TOS_WATCHLIST_WINDOW.lower()
    found: list[tuple[int, str]] = []
    def cb(hwnd: int, _arg: int) -> bool:
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        if title and "thinkorswim" in title.lower() and match in title.lower():
            found.append((hwnd, title))
        return True
    win32gui.EnumWindows(cb, 0)
    return found


def _ocr_image_texts(img_bgr: np.ndarray) -> list[str]:
    """Run OCR on a whole image, return the raw text tokens (order-insensitive)."""
    result, _ = _get_engine()(img_bgr)
    return [text for _bbox, text, _conf in result] if result else []


def _grab_window_bgr(hwnd: int) -> tuple[tuple[int, int, int, int], np.ndarray]:
    """Raise the window, screenshot its on-screen rect, return (rect, BGR image).
    Screenshot + rect are both physical-pixel (process is DPI-aware), so image
    pixel (px,py) maps to screen (L+px, T+py) — the coordinate a click uses."""
    focus_window(hwnd)
    time.sleep(0.12)
    L, T, R, B = win32gui.GetWindowRect(hwnd)
    W, H = max(1, R - L), max(1, B - T)
    shot = pyautogui.screenshot(region=(L, T, W, H))
    img = cv2.cvtColor(np.array(shot), cv2.COLOR_RGB2BGR)
    return (L, T, R, B), img


def identify_watchlist_windows() -> dict[str, int]:
    """Map {'CALL': hwnd, 'PUT': hwnd} by OCRing each watchlist window's tab
    strip for the Calls/Puts label. Falls back to WATCHLIST_FALLBACK_ORDER
    (left→right) for any window whose tab OCR is inconclusive."""
    wins = list_tos_watchlist_windows()
    if not wins:
        raise RuntimeError(f"No TOS watchlist windows (title contains "
                           f"'{TOS_WATCHLIST_WINDOW}' + 'thinkorswim'). Open both watchlists.")
    resolved: dict[str, int] = {}
    undecided: list[tuple[int, int]] = []   # (left_x, hwnd) for fallback ordering
    for hwnd, _title in wins:
        (L, _T, _R, _B), img = _grab_window_bgr(hwnd)
        # OCR just the tab strip (top ~9%), upscaled, where "LargeCap-Puts/Calls" lives.
        h = img.shape[0]
        strip = img[0:max(1, int(h * 0.09)), :]
        strip = cv2.resize(strip, (strip.shape[1] * 2, strip.shape[0] * 2), interpolation=cv2.INTER_LANCZOS4)
        blob = " ".join(_ocr_image_texts(strip)).lower()
        has_call = WATCHLIST_CALLS_TAG in blob
        has_put = WATCHLIST_PUTS_TAG in blob
        if has_call and not has_put:
            resolved.setdefault("CALL", hwnd)
        elif has_put and not has_call:
            resolved.setdefault("PUT", hwnd)
        else:
            undecided.append((L, hwnd))
    # Fill any missing side from the undecided windows using the fallback order.
    for kind in WATCHLIST_FALLBACK_ORDER:
        if kind in resolved or not undecided:
            continue
        undecided.sort(key=lambda t: t[0])   # left-most first
        _L, hwnd = undecided.pop(0)
        print(f"  WARN: tab OCR inconclusive for hwnd {hwnd}; assigning {kind} by fallback order")
        resolved[kind] = hwnd
    return resolved


def read_watchlist_rows(hwnd: int, annotate_path: Path | None = None
                        ) -> tuple[tuple[int, int, int, int], list[tuple[str, int, int]]]:
    """Screenshot the watchlist window, OCR it, and return (rect, rows) where
    rows = [(option_symbol, screen_x, screen_y), ...] sorted top→bottom. Click
    points come straight from each symbol token's OCR bbox center — no hardcoded
    row height. Only the left ~55% (symbol column) is considered. Optionally save
    an annotated screenshot (dots on detected click points) for calibration."""
    rect, img = _grab_window_bgr(hwnd)
    L, T, R, B = rect
    W = R - L
    result, _ = _get_engine()(img)
    rows: list[tuple[str, int, int, float]] = []
    if result:
        for bbox, text, _conf in result:
            m = _OPT_SYM_RE.search(text.replace(" ", "").upper())
            if not m:
                continue
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            cx = (min(xs) + max(xs)) / 2.0
            cy = (min(ys) + max(ys)) / 2.0
            if cx > W * 0.55:            # symbol lives in the left column
                continue
            rows.append((m.group(0), int(L + cx), int(T + cy), cy))
    rows.sort(key=lambda r: r[3])
    if annotate_path is not None:
        ann = img.copy()
        for sym, sx, sy, cy in rows:
            px, py = sx - L, int(cy)
            cv2.circle(ann, (px, py), 6, (0, 0, 255), 2)
            cv2.putText(ann, sym, (px + 10, py + 4), cv2.FONT_HERSHEY_SIMPLEX,
                        0.4, (0, 255, 0), 1, cv2.LINE_AA)
        WORKSPACE.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(annotate_path), ann)
    return rect, [(s, x, y) for (s, x, y, _cy) in rows]


def scroll_watchlist(rect: tuple[int, int, int, int], clicks: int) -> None:
    """Scroll the watchlist under the mouse. clicks > 0 scrolls up, < 0 down."""
    L, T, R, B = rect
    pyautogui.moveTo((L + R) // 2, (T + B) // 2)
    pyautogui.scroll(clicks)
    time.sleep(0.18)


def _scroll_to_top(rect: tuple[int, int, int, int]) -> None:
    for _ in range(25):
        scroll_watchlist(rect, 10)


def collect_watchlist_symbols(hwnd: int, max_pages: int = 80) -> list[str]:
    """Scroll a watchlist top→bottom and return the de-duplicated, ordered list
    of every option symbol in it (used for the PUTS/CALLS Count in alerts). OCR
    only — no clicking, no chart loads."""
    rect, _rows = read_watchlist_rows(hwnd)
    _scroll_to_top(rect)
    seen: set[str] = set()
    ordered: list[str] = []
    stalls = 0
    for _ in range(max_pages):
        _rect, rows = read_watchlist_rows(hwnd)
        new = [s for (s, _x, _y) in rows if s not in seen]
        for s in new:
            seen.add(s)
            ordered.append(s)
        if not new:
            stalls += 1
            if stalls >= 2:
                break
        else:
            stalls = 0
        scroll_watchlist(rect, -WATCHLIST_SCROLL_CLICKS)
    return ordered


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
def _counts_line(counts: dict | None) -> str:
    """One-line watchlist skew, e.g. 'PUTS Count=50  CALLS Count=42'."""
    if not counts:
        return ""
    return f"PUTS Count={counts.get('PUT', '?')}  CALLS Count={counts.get('CALL', '?')}"


def _levels_line(f: dict) -> str:
    """Options trade levels line, e.g. 'BUY 0.98  SL 0.68  RISK 30.66%'. Empty
    when the chart has no BUY level."""
    if not f.get("buy_price"):
        return ""
    parts = [f"BUY {f['buy_price']}"]
    if f.get("sl") is not None:
        parts.append(f"SL {f['sl']}")
    if f.get("risk_pct") is not None:
        parts.append(f"RISK {f['risk_pct']}%")
    return "  ".join(parts)


def send_pushover(ticker: str, scored: dict, f: dict, counts: dict | None = None) -> bool:
    if not (PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN):
        print("  WARN: skipping Pushover (keys missing)", file=sys.stderr)
        return False
    msg = f"REV {f.get('rv_dir') or '?'} {f.get('rv_bars')}b  {_levels_line(f)}"
    if counts:
        msg += f"\n{_counts_line(counts)}"
    body = urllib.parse.urlencode({
        "token": PUSHOVER_APP_TOKEN,
        "user": PUSHOVER_USER_KEY,
        "title": f"BIGDOG {scored['direction']}: {ticker}",
        "message": msg,
        "priority": "0",
    }).encode()
    req = urllib.request.Request("https://api.pushover.net/1/messages.json", data=body)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status == 200
    except Exception as e:
        print(f"  ERROR: Pushover send failed: {e}", file=sys.stderr)
        return False


def enqueue_whatsapp(ticker: str, scored: dict, f: dict, counts: dict | None = None) -> bool:
    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if not conn or not RECEIVER:
        print("  WARN: skipping WhatsApp (conn or receiver missing)", file=sys.stderr)
        return False
    try:
        from azure.storage.queue import QueueClient
    except ImportError:
        print("  WARN: azure-storage-queue not installed", file=sys.stderr)
        return False
    # REV U (bullish/entry) → green, REV D (bearish/exit) → red. No score.
    rd = f.get("rv_dir") or "?"
    arrow = "\U0001f7e2" if rd == "U" else "\U0001f534"
    text = (
        f"{arrow} BIGDOG {scored['direction']} {rd} — {ticker}\n"
        f"REV {rd} {f.get('rv_bars')}b  {_levels_line(f)}"
    )
    if counts:
        text += f"\n{_counts_line(counts)}"
    payload = {
        "to": RECEIVER,
        "text": text,
        "meta": {"ticker": ticker, "source": "bigdog", "counts": counts or {}},
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


def post_to_portal(ticker: str, scored: dict, f: dict, counts: dict | None = None) -> bool:
    """POST the LOCKED 17-field options contract (DEV, 2026-07-24). No score."""
    if not TIMER_SECRET:
        print("  WARN: TIMER_SECRET missing, skipping portal log", file=sys.stderr)
        return False
    cts = counts or {}
    body = json.dumps({
        "symbol": ticker,
        "side": scored["direction"],
        "system": "bigdog",
        "source": "bigdog-watchlist",
        "revDir": f.get("rv_dir"),
        "revBars": f.get("rv_bars"),
        "revPrice": f.get("rv_price"),
        "revTime": f.get("rv_time"),
        "revDate": f.get("rv_date"),
        "trend": f.get("trend"),
        "last": f.get("last"),
        "buy": f.get("buy_price"),
        "sl": f.get("sl"),
        "riskPct": f.get("risk_pct"),
        "putsCount": cts.get("PUT"),
        "callsCount": cts.get("CALL"),
        "ts": datetime.now(timezone.utc).isoformat(),
    }).encode()
    req = urllib.request.Request(
        f"{API_BASE}/api/bigdog-alert", data=body,
        headers={"Content-Type": "application/json", "x-timer-secret": TIMER_SECRET},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status == 200
    except Exception as e:
        print(f"  ERROR: portal POST failed: {e}", file=sys.stderr)
        return False


# ─── Alert dispatch (shared dedup + multi-sink) ──────────────────────────────
def dispatch_alert(symbol: str, scored: dict, f: dict,
                   counts: dict | None, args, alerted_today: set) -> bool:
    """Per-day dedup on 'SYMBOL:SIDE:REVDIR' + fan-out to WhatsApp / portal /
    Pushover. Split by revDir so a U (entry) and a later D (exit) on the same
    option both send. Returns True only when a brand-new alert was actually sent."""
    dedup_key = f"{symbol}:{scored['direction']}:{f.get('rv_dir') or '?'}"
    if dedup_key in alerted_today:
        print("  (already alerted today)")
        return False
    if args.dry_run:
        print("  (dry-run: would alert)")
        return False
    wa_ok = enqueue_whatsapp(symbol, scored, f, counts)
    portal_ok = post_to_portal(symbol, scored, f, counts)
    po_ok = send_pushover(symbol, scored, f, counts) if ENABLE_PUSHOVER else False
    if wa_ok or portal_ok or po_ok:
        alerted_today.add(dedup_key)
        print(f"  sent: whatsapp={wa_ok} portal={portal_ok} pushover={po_ok}")
        return True
    return False


# ─── Watchlist scan mode ─────────────────────────────────────────────────────
def _process_watchlist_row(kind: str, sym: str, x: int, y: int, idx: int,
                           chart_hwnd: int, counts: dict,
                           args, alerted_today: set) -> bool:
    """Click one watchlist row (loads its option chart), OCR the strip, evaluate
    the fresh-reversal gate, and alert if it fires. Returns True if a NEW alert
    was sent."""
    print(f"[{kind} {idx}] {sym} @({x},{y}) …", end=" ", flush=True)
    pyautogui.click(x, y)                       # row-click loads the linked chart
    time.sleep(WATCHLIST_CLICK_SETTLE_S + LOAD_WAIT_S)
    cap = WORKSPACE / f"wl_{sym}.png"
    if not capture_window(chart_hwnd, cap):
        print("CAPTURE FAILED")
        return False
    try:
        lines = run_ocr(crop_strip(cap, WATCHLIST_STRIP_PCT))
        f = parse_bigdog_strip(lines)
    except Exception as e:
        print(f"OCR ERROR: {e}")
        return False
    if args.show_text:
        print(f"\n  raw: {lines}\n  feat: {f}")
    scored = evaluate_watchlist(f, kind)
    tag = (f"{kind} REV {f.get('rv_dir') or '?'} {f.get('rv_bars')}b  "
           f"{_levels_line(f) or '(no levels)'}")
    if not scored["alert"]:
        print(f"no alert — {tag}")
        return False
    print(f"ALERT {tag}")
    return dispatch_alert(sym, scored, f, counts, args, alerted_today)


def run_watchlist_mode(args, chart_hwnd: int, alerted_today: set) -> tuple[int, int]:
    """Read the two on-screen TOS watchlists (Puts + Calls), click each row to
    load its option chart into `chart_hwnd`, OCR the reversal strip, and alert on
    a fresh bullish reversal. Every alert carries the PUTS/CALLS symbol counts.
    Default single-page (lists fit on screen); WATCHLIST_SCROLL adds paging."""
    wins = identify_watchlist_windows()
    print("Watchlist windows: " + ", ".join(f"{k}=hwnd {h}" for k, h in wins.items()))

    # Counts pass first (both lists) so every alert — even the first — reports skew.
    counts: dict[str, int] = {}
    list_rows: dict[str, list] = {}
    for kind in ("PUT", "CALL"):
        if kind not in wins:
            continue
        if WATCHLIST_SCROLL:
            syms = collect_watchlist_symbols(wins[kind])
            counts[kind] = len(syms)
        else:
            _rect, rows = read_watchlist_rows(wins[kind])
            list_rows[kind] = rows
            syms = [s for (s, _x, _y) in rows]
            counts[kind] = len(rows)
        print(f"{kind}S Count={counts[kind]}"
              f" ({', '.join(syms[:6])}{'…' if len(syms) > 6 else ''})")

    scanned = fired = 0
    for kind in ("PUT", "CALL"):
        if kind not in wins:
            continue
        hwnd = wins[kind]
        print(f"\n--- {kind} watchlist ---")

        if not WATCHLIST_SCROLL:
            # Whole list is on one page — re-read so click-points are current.
            _rect, rows = read_watchlist_rows(hwnd)
            for i, (sym, x, y) in enumerate(rows, 1):
                if args.max and i > args.max:
                    break
                scanned += 1
                if _process_watchlist_row(kind, sym, x, y, i, chart_hwnd,
                                          counts, args, alerted_today):
                    fired += 1
            continue

        # Scrolling list: page through, click each newly-seen row (deduped).
        rect, _ = read_watchlist_rows(hwnd)
        _scroll_to_top(rect)
        seen: set[str] = set()
        processed = 0
        stalls = 0
        stop = False
        for _page in range(120):
            _rect, rows = read_watchlist_rows(hwnd)
            new = [(s, x, y) for (s, x, y) in rows if s not in seen]
            stalls = stalls + 1 if not new else 0
            if stalls >= 2:
                break
            for (sym, x, y) in new:
                seen.add(sym)
                if args.max and processed >= args.max:
                    stop = True
                    break
                processed += 1
                scanned += 1
                if _process_watchlist_row(kind, sym, x, y, processed, chart_hwnd,
                                          counts, args, alerted_today):
                    fired += 1
            if stop:
                break
            scroll_watchlist(rect, -WATCHLIST_SCROLL_CLICKS)
    return scanned, fired


def run_calibrate_watchlist() -> int:
    """Dry, click-free: identify the windows, read one page of each, print the
    detected symbols + computed screen click-points, and save annotated
    screenshots to .state/captures/wl_calib_<KIND>.png for eyeball verification."""
    wins = identify_watchlist_windows()
    print("Identified watchlist windows: "
          + ", ".join(f"{k}=hwnd {h}" for k, h in wins.items()) or "(none)")
    for kind in ("PUT", "CALL"):
        if kind not in wins:
            print(f"  {kind}: NOT FOUND")
            continue
        ann = WORKSPACE / f"wl_calib_{kind}.png"
        _rect, rows = read_watchlist_rows(wins[kind], annotate_path=ann)
        print(f"\n{kind} watchlist (hwnd {wins[kind]}): {len(rows)} rows on the visible page")
        for sym, x, y in rows:
            print(f"    {sym:<18} click=({x},{y})")
        print(f"  annotated screenshot → {ann}")
        if WATCHLIST_SCROLL:
            total = collect_watchlist_symbols(wins[kind])
            print(f"  full-scroll count: {kind}S Count={len(total)}")
        else:
            print(f"  single-page count: {kind}S Count={len(rows)}")
    return 0


# ─── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="OCR + gate but don't alert")
    parser.add_argument("--force",   action="store_true", help="ignore market-hours gate")
    parser.add_argument("--max", type=int, default=0, help="limit to N rows per list (debug)")
    parser.add_argument("--show-text", action="store_true", help="print raw OCR + features per row")
    parser.add_argument("--pick-window", action="store_true",
                        help="force re-selection of the scanner chart (clears the saved hwnd)")
    parser.add_argument("--calibrate-watchlist", action="store_true",
                        help="watchlist mode: identify windows + dump detected symbols/click-points "
                             "(+ annotated screenshots), no clicks, no alerts")
    args = parser.parse_args()

    # OCR text (and alert emoji) can contain characters outside the console/log
    # code page (e.g. a fullwidth colon '：'); force UTF-8 so a stray glyph in a
    # print() can never crash a scan cycle or its redirected log.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    print(f"=== BigDog Scanner — {datetime.now():%Y-%m-%d %H:%M:%S} ===")

    if not HAVE_WIN_AUTOMATION:
        print("ERROR: pip install pyautogui pywin32 azure-storage-queue python-dotenv")
        return 1
    _set_dpi_aware()

    # Calibration is a standalone dry tool — no market gate, no chart window needed.
    if args.calibrate_watchlist:
        return run_calibrate_watchlist()

    if not args.force and not is_market_hours_pt():
        print(f"Outside market hours (PT {MARKET_OPEN_PT_MIN//60:02d}:{MARKET_OPEN_PT_MIN%60:02d}"
              f"–{MARKET_CLOSE_PT_MIN//60:02d}:{MARKET_CLOSE_PT_MIN%60:02d}, weekdays). "
              f"Use --force to bypass.")
        return 0

    state = load_state()
    today = datetime.now().strftime("%Y-%m-%d")
    if state.get("date") != today:
        state = {"date": today, "alerted_today": [], "scanner_hwnd": state.get("scanner_hwnd")}
    if args.pick_window:
        state["scanner_hwnd"] = None
    alerted_today = set(state["alerted_today"])   # keys: "SYMBOL:SIDE"

    found = get_or_pick_scanner_window(state)
    if not found:
        return 3
    hwnd, title = found
    if state.get("scanner_hwnd") != hwnd:
        state["scanner_hwnd"] = hwnd
        save_state(state)
        print(f"Saved scanner window for future runs: hwnd {hwnd}")
    print(f"Scanner (chart) window: '{title}' (hwnd {hwnd})")

    print("Source: TOS watchlists (Puts + Calls) — row-click load, fresh-REV-up gate")
    scanned, fired_count = run_watchlist_mode(args, hwnd, alerted_today)
    state["alerted_today"] = sorted(alerted_today)
    save_state(state)
    print(f"\n=== Scan complete: {scanned} rows, {fired_count} new alerts ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
