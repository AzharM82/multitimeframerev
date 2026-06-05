"""
TOS Reversal Monitor — OCR edition.

Replaces the Claude-Sonnet-based monitor at ~/.openclaw/tos_reversal_monitor.py.
Same workflow:
  1. PowerShell PrintWindow captures every visible TOS Charts window.
  2. RapidOCR (ONNX, no PyTorch) reads the OCR label strip rendered by the
     Azhar_Reversal study (TREND / REV / BUY / SL / TP / R chips).
  3. State changes (new reversal, new buy) trigger a Telegram alert with the
     screenshot + full BUY/SL/TP/R numbers — actionable enough for an algo.

Differences from the Claude version:
  - $0 ongoing cost (was ~$10–20/mo on Sonnet 4.6).
  - ~5s per chart (was ~10–15s + API latency).
  - Alerts include actual price levels, not just "GREEN/RED REVERSAL".

Production install:
  Copy this file to C:\\Users\\reach\\.openclaw\\tos_reversal_monitor.py
  (or symlink). The existing run_tos_monitor.bat + Windows Task Scheduler
  entry continue to work unchanged.

Requires: pip install rapidocr-onnxruntime opencv-python pillow numpy
"""

import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

# ─── Config ──────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ.get(
    "TELEGRAM_BOT_TOKEN", "8565870400:AAEWDFi3MTk1ucmwbeiTetyz0obrSy7SlnQ"
)
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "457374459")
WORKSPACE = Path.home() / ".openclaw" / "workspace"
STATE_FILE = Path.home() / ".openclaw" / "alert_state.json"
STRIP_PCT = 0.08  # top 8% of chart — captures the AddLabel strip


# ─── OCR pipeline ────────────────────────────────────────────────────────────
_engine = None
def _get_engine() -> RapidOCR:
    global _engine
    if _engine is None:
        _engine = RapidOCR()
    return _engine


def crop_strip(image_path: Path, strip_pct: float = STRIP_PCT) -> np.ndarray:
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    strip = img.crop((0, 0, w, int(h * strip_pct)))
    strip = strip.resize((strip.width * 2, strip.height * 2), Image.LANCZOS)
    arr = np.array(strip)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


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
_BUY_RE = re.compile(
    r"\bBUY\s*[\$S]?\s*(?P<price>\d+\.\d{2})\s*(?P<bars>\d+)\s*[bB]\b",
    re.IGNORECASE,
)
_SL_RE = re.compile(r"\bSL\s*[\$S]?\s*(?P<price>\d+\.\d{2})\b", re.IGNORECASE)
_TP_RE = re.compile(r"\bTP\s*[\$S]?\s*(?P<price>\d+\.\d{2})\b", re.IGNORECASE)
_R_RE  = re.compile(r"\bR\s*(?P<value>\d+\.\d{2})\b")
_TICKER_RE = re.compile(r"^([A-Z]{1,6})(?=\d|\s|[^A-Z]|$)")


def parse_strip(lines: list[str]) -> dict:
    blob = " ".join(lines)
    out: dict = {
        "ticker": None,
        "trend": None,
        "reversal": {"direction": None, "price": None, "date": None, "time": None, "bars_ago": None},
        "trade": {"buy": None, "buy_bars_ago": None, "sl": None, "tp": None, "r_multiple": None},
    }
    if lines:
        m = _TICKER_RE.match(lines[0].strip())
        if m:
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
    if (m := _BUY_RE.search(blob)):
        out["trade"]["buy"]          = float(m.group("price"))
        out["trade"]["buy_bars_ago"] = int(m.group("bars"))
    if (m := _SL_RE.search(blob)):
        out["trade"]["sl"] = float(m.group("price"))
    if (m := _TP_RE.search(blob)):
        out["trade"]["tp"] = float(m.group("price"))
    if (m := _R_RE.search(blob)):
        out["trade"]["r_multiple"] = float(m.group("value"))
    return out


# ─── Window capture (unchanged from the Claude monitor) ──────────────────────
def find_and_capture_all_tos_windows() -> list[tuple[str, str]]:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    ps_script_path = str(WORKSPACE / "capture_all_tos.ps1")
    workspace_escaped = str(WORKSPACE).replace('\\', '\\\\')
    ps_script = '''
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
public class WindowCapture {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static List<KeyValuePair<IntPtr, string>> FindWindows(string pattern) {
        var results = new List<KeyValuePair<IntPtr, string>>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.ToLower().Contains(pattern.ToLower())) {
                results.Add(new KeyValuePair<IntPtr, string>(hWnd, title));
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
    public static void Capture(IntPtr hwnd, string path) {
        RECT rc; GetWindowRect(hwnd, out rc);
        int w = rc.Right - rc.Left; int h = rc.Bottom - rc.Top;
        if (w <= 0 || h <= 0) throw new Exception("Invalid window size");
        Bitmap bmp = new Bitmap(w, h);
        Graphics g = Graphics.FromImage(bmp);
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2);
        g.ReleaseHdc(hdc); g.Dispose();
        bmp.Save(path, ImageFormat.Png); bmp.Dispose();
    }
}
"@ -ReferencedAssemblies System.Drawing
$allWindows = [WindowCapture]::FindWindows("thinkorswim")
if ($allWindows.Count -eq 0) { Write-Error 'No ThinkOrSwim windows found'; exit 1 }
$results = @(); $index = 0
foreach ($win in $allWindows) {
    $hwnd = $win.Key; $title = $win.Value
    if ($title -match 'Charts') {
        $outPath = "''' + workspace_escaped + '''\\tos_scan_$index.png"
        try { [WindowCapture]::Capture($hwnd, $outPath); $results += "$index|$title|$outPath"; $index++ }
        catch { Write-Warning "Failed to capture: $title - $_" }
    }
}
if ($results.Count -eq 0) { Write-Error 'No chart windows captured'; exit 1 }
$results | ForEach-Object { Write-Host $_ }
'''
    with open(ps_script_path, "w") as f:
        f.write(ps_script)
    result = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", ps_script_path],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        print(f"Capture failed: {result.stderr}")
        return []
    captures = []
    for line in result.stdout.strip().split("\n"):
        line = line.strip()
        if "|" in line:
            parts = line.split("|", 2)
            if len(parts) >= 3:
                captures.append((parts[1].strip(), parts[2].strip()))
    return captures


# ─── Telegram ────────────────────────────────────────────────────────────────
def send_telegram_photo(image_path: str, caption: str = "") -> dict:
    boundary = "----FormBoundary7MA4YWxkTrZu0gW"
    with open(image_path, "rb") as f:
        image_data = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="chat_id"\r\n\r\n{TELEGRAM_CHAT_ID}\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="caption"\r\n\r\n{caption}\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="photo"; filename="chart.png"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode() + image_data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read().decode())


# ─── State ───────────────────────────────────────────────────────────────────
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ─── Alert decisioning ───────────────────────────────────────────────────────
def reversal_signature(parsed: dict) -> str | None:
    """Stable identifier for a reversal — direction + price + date + time.
    Used to detect when a NEW reversal has fired (vs the same one carried fwd)."""
    rev = parsed["reversal"]
    if not rev["direction"]:
        return None
    return f"{rev['direction']}|{rev['price']}|{rev['date']}|{rev['time']}"


def trade_signature(parsed: dict) -> str | None:
    """Identifier for a trade — buy price + buy date stamp via REV time as proxy."""
    tr = parsed["trade"]
    rev = parsed["reversal"]
    if tr["buy"] is None:
        return None
    return f"{tr['buy']}|{tr['sl']}|{tr['tp']}|{rev.get('date')}"


def format_alert(parsed: dict) -> str:
    rev = parsed["reversal"]
    tr = parsed["trade"]
    ticker = parsed["ticker"] or "?"
    trend = parsed["trend"] or "?"

    dir_emoji = "\U0001f7e2" if rev["direction"] == "U" else "\U0001f534"
    lines = [
        f"{dir_emoji} {ticker} REV {rev['direction']} @ ${rev['price']}",
        f"\U0001f550 {rev['date']} {rev['time']} ({rev['bars_ago']} bars ago)",
        f"\U0001f4c8 Trend {trend}",
    ]
    if tr["buy"] is not None:
        trade_line = f"\U0001f3af BUY ${tr['buy']}"
        if tr["sl"] is not None:
            trade_line += f" / SL ${tr['sl']}"
        if tr["tp"] is not None:
            trade_line += f" / TP ${tr['tp']}"
        lines.append(trade_line)
        if tr["r_multiple"] is not None:
            lines.append(f"⚖️  R {tr['r_multiple']}")
    return "\n".join(lines)


# ─── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    print(f"=== TOS Reversal Monitor (OCR) — {datetime.now():%Y-%m-%d %H:%M:%S} ===")

    print("Scanning for ThinkOrSwim chart windows...")
    captures = find_and_capture_all_tos_windows()
    if not captures:
        print("No ThinkOrSwim chart windows found. Is TOS running with charts open?")
        return 1
    print(f"Found {len(captures)} chart window(s)")

    # Filter out tiny captures (toolbars, title bars).
    valid = []
    for title, filepath in captures:
        try:
            fsize = Path(filepath).stat().st_size
            if fsize < 50_000:
                print(f"Skipping tiny capture ({fsize} bytes): {title}")
                continue
            valid.append((title, filepath))
        except OSError:
            continue
    captures = valid

    state = load_state()
    alerts_sent = 0

    for i, (title, filepath) in enumerate(captures):
        print(f"\n--- Window {i+1}/{len(captures)}: {title} ---")
        t0 = time.time()
        try:
            cropped = crop_strip(Path(filepath))
            lines = run_ocr(cropped)
            parsed = parse_strip(lines)
        except Exception as e:
            print(f"OCR failed: {e}")
            continue
        elapsed = time.time() - t0

        ticker = parsed["ticker"]
        if not ticker:
            print(f"OCR did not find a ticker (took {elapsed:.1f}s) — skipping.")
            continue

        print(f"OCR ({elapsed:.1f}s): {json.dumps(parsed, indent=2)}")

        rev_sig   = reversal_signature(parsed)
        trade_sig = trade_signature(parsed)
        prev = state.get(ticker, {})
        prev_rev_sig   = prev.get("reversal_sig")
        prev_trade_sig = prev.get("trade_sig")

        new_reversal = rev_sig is not None and rev_sig != prev_rev_sig
        new_trade    = trade_sig is not None and trade_sig != prev_trade_sig

        if not new_reversal and not new_trade:
            print(f"{ticker}: no state change, skipping.")
        else:
            reasons = []
            if new_reversal: reasons.append("new REV")
            if new_trade:    reasons.append("new TRADE")
            print(f"{ticker}: state changed ({', '.join(reasons)}) — sending alert.")
            try:
                send_telegram_photo(filepath, caption=format_alert(parsed))
                alerts_sent += 1
                print(f"Telegram alert sent for {ticker}")
            except Exception as e:
                print(f"Telegram send failed: {e}")
                continue  # don't update state if alert failed

        state[ticker] = {
            "reversal_sig": rev_sig,
            "trade_sig": trade_sig,
            "parsed": parsed,
            "checked_at": datetime.now().isoformat(),
        }

    save_state(state)
    print(f"\n=== Scan complete. {len(captures)} charts processed, {alerts_sent} alert(s) sent. ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
