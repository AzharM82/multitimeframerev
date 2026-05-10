# Chart-OCR tools

Reads the Azhar_Reversal label strip from TOS chart screenshots into structured
JSON. Three entry points, all sharing the same OCR pipeline (RapidOCR + regex):

| Script | Purpose |
|---|---|
| `test_local.py` | Test a local Ollama vision model on a screenshot — useful for comparing to OCR. |
| `test_ocr.py` | Run RapidOCR + regex against a single screenshot — fastest sanity check. |
| `tos_monitor.py` | Production monitor — captures every TOS Charts window, alerts via Telegram. Mirrors `~/.openclaw/tos_reversal_monitor.py`. |
| `finviz_scanner.py` | Pulls a Finviz Elite screener, loads each ticker into a dedicated TOS chart, OCRs, alerts via WhatsApp + portal. |

## Setup (one-time)

```powershell
pip install rapidocr-onnxruntime opencv-python pillow numpy `
            pyautogui pywin32 azure-storage-queue python-dotenv
```

For `finviz_scanner.py`:

```powershell
copy .env.example .env
# Fill in the values (see comments in .env.example)
```

## Required ThinkScript study

The OCR pipeline reads the `AddLabel` chips rendered by `docs/thinkscript-ocr.tos`
(Azhar_Reversal study with `showOcrLabels = yes`). Without it the strip is empty
and tickers will be parsed but no REV/BUY/SL/TP fields will populate.

## Finviz scanner — operator's guide

### How it works each cycle
1. Skip if outside market hours (default 6:30 AM – 1:00 PM PT, weekdays). Override with `--force`.
2. Pull tickers from `FINVIZ_SCREENER_URL` (auto-rewrites `/screener` → `/export.ashx`, appends `&auth=`).
3. Find the TOS window whose title contains `TOS_SCANNER_WINDOW`.
4. For each ticker:
   - Focus the window → `Ctrl+L` → type ticker → Enter
   - Wait `SCANNER_LOAD_WAIT_S` seconds for the chart to repaint
   - PowerShell PrintWindow capture
   - Crop top 8% → RapidOCR → regex parse
   - If `reversal.direction == "U"` AND label time is within `SCANNER_FRESH_MINUTES`:
     - Enqueue WhatsApp via `AZURE_STORAGE_CONNECTION_STRING` queue
     - POST to `/api/scanner-alert` (logs to `AlertLog` → shows up on Day Trades page)
5. Per-day dedup: same ticker only alerts once per trading day.

### TOS setup
- Open one chart, apply the OCR-friendly Azhar_Reversal study, set `showOcrLabels = yes`.
- **First run picks the chart interactively** — when you run the script the first time, it lists every visible TOS Charts window and asks you to pick which one to use as the scanner. The chosen hwnd is saved to `.state/scanner_state.json` and reused on every subsequent run. No chart renaming required.
- If TOS restarts (handles change), the script auto-detects the dead hwnd and re-prompts. Force a re-pick anytime with `--pick-window`.
- Optional: set `TOS_SCANNER_WINDOW=Scanner` (or any substring) in `.env` to skip the interactive picker entirely — it'll match the first chart whose title contains that string.
- Don't interact with this chart while a scan is running — keystrokes will hijack focus for ~3-5 minutes per cycle.

### Schedule it
Windows Task Scheduler:
- **Trigger**: Daily, repeat **every 5 minutes** for 6h 30m starting 6:30 AM
- **Action**: `C:\Users\reach\MultiTimeframeReversal\tools\chart-ocr\run_finviz_scanner.bat`
- **Conditions**: Wake the computer to run this task → off (your call)
- **Settings**: Stop after 5 minutes (one cycle should always finish before the next tick)

5-min cadence aligns with 5m chart bar prints. With `SCANNER_FRESH_BARS=2`,
a reversal that just printed (`bars_ago=0`) is caught the same cycle, and
even if a scan slips by one bar boundary, `bars_ago=1` is still alerted.

The script gates itself on market hours, so triggering it more often than needed is harmless — it returns immediately outside the window.

### Manual debug
```powershell
# Dry run — full OCR + decisioning, no alerts:
python finviz_scanner.py --dry-run

# Just the first 3 tickers for fast iteration:
python finviz_scanner.py --max 3 --force

# Show raw OCR text per ticker:
python finviz_scanner.py --max 3 --force --show-text
```
