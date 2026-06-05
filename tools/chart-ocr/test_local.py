"""
test_local.py — Test local Ollama vision model against a TOS chart screenshot.

Reads the OCR label strip at the top of an Azhar_Reversal chart (TREND / REV /
BUY / SL / TP / R chips) and outputs structured JSON. No Anthropic API calls,
no external services beyond a local `ollama serve`.

Usage:
    python test_local.py <path-to-screenshot.png>
    python test_local.py <path-to-screenshot.png> --model qwen2.5vl:7b
    python test_local.py <path-to-screenshot.png> --model llama3.2-vision:11b

Requires:
    - Ollama running (`ollama serve` or background service)
    - The model already pulled (`ollama pull llama3.2-vision:11b`)
"""

import argparse
import base64
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_MODEL = "llama3.2-vision:11b"
DEFAULT_STRIP_PCT = 0.08  # top 8% of the chart — captures the AddLabel strip

PROMPT = """You are reading a ThinkOrSwim trading chart screenshot with a dark background.

At the very TOP of the chart there is a horizontal strip of small colored text labels (chips).
The strip uses this exact format, with each chip separated by visible whitespace:

  TREND <UP|DN|FLAT>
  REV <U|D> $<price> <M/D> <HH:MM> <N>b
  BUY $<price> <N>b
  SL $<price>
  TP $<price>
  R <number>

Notes:
 - Some chips may be missing entirely (e.g. no BUY/SL/TP/R if no trade has fired).
 - "U" means an up-reversal; "D" means a down-reversal.
 - "Nb" means N bars ago (e.g. "33b" = 33 bars since signal).
 - "$" is a literal dollar sign in front of the price; ignore it for parsing.

Also read the ticker symbol from the very top-left of the window (e.g. "PLTR", "AAPL", "SPY").

Output ONLY a single JSON object in this exact format. Do not include any other text,
no code fences, no preamble, no commentary.

{
  "ticker": "<symbol or null>",
  "trend": "<UP|DN|FLAT|null>",
  "reversal": {
    "direction": "<U|D|null>",
    "price": <number or null>,
    "date": "<M/D or null>",
    "time": "<HH:MM or null>",
    "bars_ago": <integer or null>
  },
  "trade": {
    "buy": <number or null>,
    "buy_bars_ago": <integer or null>,
    "sl": <number or null>,
    "tp": <number or null>,
    "r_multiple": <number or null>
  }
}

If a field is not visible on the chart, set it to null. Do not invent values."""


def crop_label_strip(image_path: Path, strip_pct: float = DEFAULT_STRIP_PCT) -> bytes:
    """Crop just the top of the chart (where the OCR label strip lives) and
    return the cropped PNG as bytes. Eliminates tooltip/x-axis confusion
    and shrinks the model's input dramatically.

    strip_pct=0.08 means top 8% of the image height. Adjust if your TOS
    has unusual window decoration heights.
    """
    img = Image.open(image_path)
    w, h = img.size
    strip = img.crop((0, 0, w, int(h * strip_pct)))
    buf = io.BytesIO()
    strip.save(buf, format="PNG")
    return buf.getvalue()


def call_ollama(model: str, image_b64: str) -> str:
    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [image_b64],
        "stream": False,
        "options": {"temperature": 0},
    }
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=600)
    body = json.loads(resp.read().decode())
    return body.get("response", "").strip()


def extract_json(raw: str) -> dict:
    # Model might wrap output in code fences or add commentary despite instructions.
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        raise ValueError(f"no JSON object found in model output: {raw!r}")
    return json.loads(m.group(0))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("image", help="Path to TOS chart screenshot (PNG)")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"Ollama model name (default: {DEFAULT_MODEL})")
    parser.add_argument("--crop-strip", action="store_true",
                        help="Crop to just the top of the chart (the AddLabel strip) "
                             "before sending — much faster + eliminates tooltip noise")
    parser.add_argument("--strip-pct", type=float, default=DEFAULT_STRIP_PCT,
                        help=f"Fraction of image height to keep when --crop-strip is set "
                             f"(default: {DEFAULT_STRIP_PCT})")
    parser.add_argument("--save-crop", type=str, default=None,
                        help="If set with --crop-strip, also write the cropped image to this path")
    parser.add_argument("--show-raw", action="store_true",
                        help="Print raw model output before the parsed JSON")
    args = parser.parse_args()

    img_path = Path(args.image)
    if not img_path.exists():
        print(f"ERROR: file not found: {img_path}", file=sys.stderr)
        return 1

    print(f"Image: {img_path} ({img_path.stat().st_size:,} bytes)", file=sys.stderr)
    print(f"Model: {args.model}", file=sys.stderr)

    if args.crop_strip:
        img_bytes = crop_label_strip(img_path, args.strip_pct)
        print(f"Crop:  top {args.strip_pct:.0%} → {len(img_bytes):,} bytes "
              f"({len(img_bytes) / img_path.stat().st_size:.0%} of original)",
              file=sys.stderr)
        if args.save_crop:
            Path(args.save_crop).write_bytes(img_bytes)
            print(f"Crop saved to: {args.save_crop}", file=sys.stderr)
    else:
        img_bytes = img_path.read_bytes()

    img_b64 = base64.b64encode(img_bytes).decode()

    t0 = time.time()
    try:
        raw = call_ollama(args.model, img_b64)
    except urllib.error.URLError as e:
        print(f"ERROR: Ollama unreachable at {OLLAMA_URL} — is `ollama serve` running? ({e})",
              file=sys.stderr)
        return 2
    elapsed = time.time() - t0
    print(f"Inference: {elapsed:.1f}s", file=sys.stderr)

    if args.show_raw:
        print(f"\n--- raw model output ---\n{raw}\n--- end raw ---\n", file=sys.stderr)

    try:
        parsed = extract_json(raw)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        print(f"\n--- raw model output ---\n{raw}\n", file=sys.stderr)
        return 3

    print(json.dumps(parsed, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
