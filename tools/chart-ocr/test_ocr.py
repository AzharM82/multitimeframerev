"""
test_ocr.py — Deterministic OCR pipeline for the TOS Azhar_Reversal label strip.

Crops the top of a TOS chart screenshot, runs RapidOCR (ONNX runtime, no LLM,
no PyTorch, no API calls), and regex-parses the extracted text into the same
JSON shape as test_local.py.

Why this exists: vision LLMs hallucinate small numbers (R 1.96 → R 1.1) and
miss low-contrast chips (SL pink-on-black). Our label strip has a fixed grammar,
so a deterministic OCR + parser is faster, free, and 100% accurate on the
fields it can read.

Usage:
    python test_ocr.py <path-to-screenshot.png>
    python test_ocr.py <path-to-screenshot.png> --strip-pct 0.10
    python test_ocr.py <path-to-screenshot.png> --show-text   # show raw OCR lines
"""

import argparse
import io
import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

DEFAULT_STRIP_PCT = 0.08

# Engine instance — reused across calls; loads ONNX models lazily.
_engine = None
def get_engine() -> RapidOCR:
    global _engine
    if _engine is None:
        _engine = RapidOCR()
    return _engine


def crop_strip(image_path: Path, strip_pct: float) -> np.ndarray:
    """Crop top-strip of the chart and return as a CV2 BGR ndarray.
    Also upscales 2× to give OCR more pixel detail on small chip text."""
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    strip = img.crop((0, 0, w, int(h * strip_pct)))
    # Upscale 2× — small TOS label fonts (~10px tall) OCR much better at 20px.
    strip = strip.resize((strip.width * 2, strip.height * 2), Image.LANCZOS)
    arr = np.array(strip)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def run_ocr(img: np.ndarray) -> list[str]:
    """Return a flat list of OCR'd text strings, in left-to-right reading order."""
    engine = get_engine()
    result, _ = engine(img)
    if not result:
        return []
    # result entries: [bbox_4points, text, confidence]
    # Sort by leftmost x of bounding box so chips read left→right.
    items = []
    for entry in result:
        bbox, text, _conf = entry
        x_left = min(p[0] for p in bbox)
        items.append((x_left, text))
    items.sort(key=lambda t: t[0])
    return [t for _, t in items]


# ─── Parsers ────────────────────────────────────────────────────────────────
# The label strip uses these chip formats (some optional):
#   TREND <UP|DN|FLAT>
#   REV <U|D> $<price> <M/D> <HH:MM> <N>b
#   BUY $<price> <N>b
#   SL $<price>
#   TP $<price>
#   R <number>
#
# OCR tends to merge chips into one or two strings, e.g.:
#   "TREND UP REV U $135.04 5/8 13:10 33b BUY $135.11 32b SL $134.89 TP $135.54 R 1.96"
# So we join all text with spaces and regex-extract each chip from the joined blob.

# RapidOCR collapses inter-word whitespace ('TRENDUP', 'BUY$135.1132b'), and
# sometimes mis-reads '$' as 'S' on dark backgrounds ('SLS134.89' instead of
# 'SL$134.89'). All patterns below use \s* (zero or more) and [\$S]? to handle
# both. Prices are constrained to \d+\.\d{2} (TOS AsDollars always renders
# two decimals) so the regex can find the boundary between e.g. "135.04" and
# "5/8" even when run together as "135.045/8".
_TREND_RE = re.compile(r"\bTREND\s*(UP|DN|FLAT)\b", re.IGNORECASE)
_REV_RE = re.compile(
    # ThinkScript zero-pads hour and minute, so time is always exactly HH:MM.
    # Constraining time to \d{2}:\d{2} forces date \d{1,2}/\d{1,2} to backtrack
    # correctly when OCR runs them together as e.g. "5/813:10" → "5/8" + "13:10".
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
# R chip — must NOT match 'R:0.17' from TOS chart-info bar. Require the
# digit to come right after R (no colon), and constrain to 2-decimal form.
_R_RE  = re.compile(r"\bR\s*(?P<value>\d+\.\d{2})\b")
# Ticker = leading uppercase letters before any digit (e.g. 'PLTR1D5m' → 'PLTR').
_TICKER_RE = re.compile(r"^([A-Z]{1,6})(?=\d|\s|[^A-Z]|$)")


def parse_strip(lines: list[str]) -> dict:
    blob = " ".join(lines)
    out = {
        "ticker": None,
        "trend": None,
        "reversal": {
            "direction": None, "price": None, "date": None,
            "time": None, "bars_ago": None,
        },
        "trade": {
            "buy": None, "buy_bars_ago": None,
            "sl": None, "tp": None, "r_multiple": None,
        },
    }

    # Ticker — try first line first, then anywhere in blob
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("image", help="Path to TOS chart screenshot (PNG)")
    parser.add_argument("--strip-pct", type=float, default=DEFAULT_STRIP_PCT,
                        help=f"Fraction of image height to crop from top (default: {DEFAULT_STRIP_PCT})")
    parser.add_argument("--show-text", action="store_true",
                        help="Print raw OCR'd text lines before the parsed JSON")
    parser.add_argument("--save-crop", type=str, default=None,
                        help="Write the cropped/upscaled image to this path for inspection")
    args = parser.parse_args()

    img_path = Path(args.image)
    if not img_path.exists():
        print(f"ERROR: file not found: {img_path}", file=sys.stderr)
        return 1

    print(f"Image: {img_path} ({img_path.stat().st_size:,} bytes)", file=sys.stderr)

    t0 = time.time()
    cropped = crop_strip(img_path, args.strip_pct)
    print(f"Crop:  {cropped.shape[1]}x{cropped.shape[0]} (top {args.strip_pct:.0%}, 2× upscaled)",
          file=sys.stderr)

    if args.save_crop:
        cv2.imwrite(args.save_crop, cropped)
        print(f"Crop saved to: {args.save_crop}", file=sys.stderr)

    lines = run_ocr(cropped)
    elapsed = time.time() - t0
    print(f"OCR:   {len(lines)} text regions, {elapsed:.2f}s total", file=sys.stderr)

    if args.show_text:
        print("\n--- raw OCR lines ---", file=sys.stderr)
        for i, l in enumerate(lines):
            print(f"  [{i:2d}] {l!r}", file=sys.stderr)
        print("--- end raw ---\n", file=sys.stderr)

    parsed = parse_strip(lines)
    print(json.dumps(parsed, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
