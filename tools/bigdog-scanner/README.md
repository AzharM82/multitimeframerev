# BigDog Trades

Intraday 5-minute alerting system. Scans **two** Finviz-screened universes (a
bullish and a bearish list) on a live ThinkorSwim chart, reads a **signed
composite score (−6…+6)** off a single consolidated OCR label strip, and alerts
you via WhatsApp when a setup clears the gate. Every alert is logged
with its full feature payload to the MTF Reversal portal for later research.

Chart-truth: the score AND every value come off the chart your own studies draw
— no server-side re-derivation (Python recomputes only as a QA cross-check).

## The 6 metrics → one signed score → one OCR strip

`thinkscript/BigDog_OCR.tos` is one `declare upper` study that computes each
metric's signed contribution, sums them into `BD SC`, and relocates every label
into the price-pane top strip so a single screenshot captures everything. Built
from your own study sources in `Scripts/`:

| Chip | Metric | Source | +1 bullish / −1 bearish |
|------|--------|--------|-------------------------|
| `REV` | Reversal (no freshness gate) | `Reversal.txt` | in up-reversal / in down-reversal |
| `BD AT A\|B` | close vs ATR line | `ATR.txt` | above / below |
| `BD VW A\|B` | close vs VWAP | `VWAP.txt` (DAY VWAP) | above / below |
| `BD BV nn` | buy-volume % last bar | `BuySellVol.txt` | Buy ≥70 / Sell ≥70 |
| `BD CT P\|N nn` | TICK day breadth | `TICK.txt` | more green bars / more red bars today |
| `BD ST k d` | Stoch SlowK/SlowD | `Stochastic.txt` (7/3/EXP) | K>D / K<D |
| `BD SC P\|N\|Z n` | **composite score** | — | sum of the six, −6…+6 |

**Alert** when the on-chart score clears the gate: **bull universe → score ≥ +3**,
**bear universe → score ≤ −3** (`ALERT_MIN=3`).

## Setup on DESKTOP2

1. **Install the study.** TOS → Studies → Edit Studies → Create → paste
   `thinkscript/BigDog_OCR.tos` → name it `BigDog_OCR` → add to a **5-minute**
   chart. Confirm the strip shows `TREND … REV … BD VW … BD AT … BD BV … BD CT …
   BD ST …` and that each chip matches the underlying panes (spot-check the ATR
   line and Buy% especially).
2. **Python deps:**
   `pip install rapidocr_onnxruntime opencv-python pillow numpy pyautogui pywin32 azure-storage-queue python-dotenv`
3. **Config:** `copy scanner\.env.example scanner\.env` and fill in the keys
   (Finviz, Azure Storage, TIMER_SECRET; Pushover optional via ENABLE_PUSHOVER).
4. **Pick the chart window (once, from a terminal):**
   `python scanner\bigdog_scanner.py --force --pick-window`
   — choose the BigDog chart; its hwnd is saved to `.state\scanner_state.json`.
5. **Schedule:** from an **elevated** PowerShell, `Scripts\setup_task_scheduler.ps1`
   (every 5 min, RunLevel Highest — required so keystrokes reach elevated TOS).

## Running / debugging

```
python scanner\bigdog_scanner.py --dry-run --show-text --max 3   # OCR + parse + score, no alerts
python scanner\bigdog_scanner.py --force                         # full run, ignore market-hours gate
python scanner\bigdog_scanner.py                                 # one scheduled cycle (self-gates)
```

Captures land in `scanner\.state\captures\scan_<TICKER>.png` — open one if a
chip won't parse. Per-day, per-direction dedup lives in
`scanner\.state\scanner_state.json` (keys `TICKER:U` / `TICKER:D`).

## Tuning

All thresholds are env vars (see `.env.example`): `FRESH_BARS`, `BUY_PCT_MIN`,
`TICK_MIN`, `REQUIRE_TREND`, `STOCH_USE_BANDS`, `ALERT_MIN`. Change and re-run —
no code edit. The portal logs the thresholds in effect alongside each alert, so
a research agent can re-score history under new hypotheses.

## Alerts & logging

- **WhatsApp (primary):** enqueued to the `whatsapp-alerts` Azure queue; the
  `tools/whatsapp-sidecar` process drains it and sends. **Requires the sidecar
  running** on an always-on machine (one-time WhatsApp Web QR login).
- **Pushover (opt-in):** set `ENABLE_PUSHOVER=true`. Title `BIGDOG LONG|SHORT ±n: TICKER`.
- **Portal:** `POST /api/bigdog-alert` (auth `x-timer-secret`) → Azure Table
  `BigDogAlerts`, full signed-score payload + raw features + JSON blob → BIGD-Intraday tab.

## Layout

```
thinkscript/BigDog_OCR.tos           consolidated OCR study (install on DESKTOP2)
Scripts/*.txt                        your 6 original TOS sources (reference)
Scripts/run_bigdog.bat               Task Scheduler entry point
Scripts/setup_task_scheduler.ps1     scheduler registration
scanner/bigdog_scanner.py            Finviz → TOS → OCR → score → alert
scanner/.env(.example)               config
```
(`Scripts/` holds both the TOS sources and the ops scripts — Windows treats
`scripts/` and `Scripts/` as the same folder.)
