# MTF Reversal — How it works

This site is a **swing-trade-first** suite built around several tools: **AVWAP** swing setups, a TOS-fed **Bull List**, **Day-Trade** reversal alerts, and the **ATR Matrix** extension scanner — with a whole-market **breadth/posture** gauge on top. The whole pipeline is owned by the user — no third-party scanners, no SaaS subscriptions beyond Polygon.io for market data, Finviz Elite for screens, and Outlook/Gmail for email.

## The 5 sections

### 1 · AVWAP Swing Scanner

End-of-day scan at **4:15 PM ET** weekdays. Reads ~209 liquid tickers, computes Anchored VWAP from five anchors per ticker — All-Time High, 52-Week High, 52-Week Low, YTD start, and a major swing low — then looks for three Brian Shannon patterns:

- **Pullback** — price within 1.5% of an anchor AVWAP, daily close above it, broader trend up.
- **Pinch** — three or more AVWAPs converge inside a 2% band (coiled spring before a breakout).
- **Reclaim** — daily close reclaims an anchor AVWAP after being below it for 5+ consecutive days.

Each hit gets a 0–100 score weighted by confluence, band tightness, volume vs 20-day average, trend alignment (50/200 SMA + RSI), and freshness. The top 30 land in your inbox at `reachazhar@hotmail.com` and on the AVWAP tab here.

> **No intraday alerts.** This is a daily research workflow, not a notifier.

### 2 · Bull List

Polls the inbox at `tosbullalerts@live.com` every hour. When a TOS scan email lands with subject like `Alert: New symbol: DASH was added to D-Bull-Sig`, the parser:

1. Filters on `D-Bull-Sig` (case-insensitive) — everything else is ignored.
2. Extracts the ticker.
3. Pulls 2 years of daily bars from Polygon.
4. Runs the same ZigZag reversal detection used across the rest of the system to find the most recent **U1** signal.
5. Computes **buy = open of bar after U1**, **stop = low of bar two before U1**, **target = buy × 1.05**.
6. Persists as an **OPEN** row.

Every 30 minutes during market hours, a monitor checks each open row against the live last trade and flips it to **TP_HIT**, **SL_HIT**, or **EXPIRED** (after 10 trading days).

### 3 · Day Trade Alerts

Every 10 minutes between 9:30 AM and 3:30 PM ET, the system takes the **union of AVWAP top-30 + open Bull List** and runs the existing reversal scan focused on the 10-minute timeframe. A fresh **U1** within the last 2 bars fires an alert, deduplicated for 30 minutes per ticker.

Alerts are sent two ways:
- **Primary**: Azure Storage Queue → local WhatsApp sidecar (whatsapp-web.js) → message arrives from your sender phone to your receiver phone.
- **Fallback**: if the sidecar is offline or the queue write fails, Pushover fires instead. No alert is lost.

### 4 · ATR Matrix — swing extension scanner

A daily swing-trade dashboard built on the **@SteveDJacobs "ATR Matrix"** framework. Instead of hunting reversals, it asks a different question: *of the strong, trending stocks, which are in a good place to enter, which are getting overextended, and which to leave alone?*

**The core number — extension.** For every stock, `extension = (Close − SMA50) / ATR` — how many Average True Ranges it sits above its 50-day average. A stock 2 ATRs above its 50-day is "2x extended." Dividing by ATR normalizes for each stock's own volatility, so a calm name and a wild name are directly comparable.

**Zones** (extension bucketed by `floor`):

| Zone | Extension | Meaning |
|---|---|---|
| LEAVE | below 0 | below the 50-day — not a long |
| ENTRY | 0–4x | in trend, not stretched — best place to start a position |
| HOLD | 5–6x | extended but fine to hold |
| EXTENDED | 7–10x | overbought — trim, don't initiate |
| BLOW-OFF | 11x+ | parabolic — take profits |

**Grade.** Each stock gets a 0–6 **structure score** for how cleanly its moving-average stack is aligned (Close ≥ EMA10 ≥ SMA20 ≥ SMA50 ≥ SMA100 ≥ SMA200, plus a rising 50-day): 6 = grade **A**, 0 = grade **G**. A `+`/`−` is appended from the stock's **RS percentile** (its 1w/1m/3m/6m return rank within the scanned universe). So **A+** = perfect trend structure *and* top-tier relative strength.

**Action signal** (the chip's left-border color): `sell` (below 50-day) · `reduce` (below 20-day) · `inflection`/`restore` (reclaiming a moving average) · **`buy`** (structure ≥ 5, 0–4x extended, above-average ATR-RS) · `hold`.

**Universe.** A Finviz Elite screen of mid-cap+ US optionable names in a confirmed uptrend (SMA20 > SMA50 > SMA200), price > $10, ATR > 1.5, decent volume (~215 names). Daily bars from Polygon. The scan runs once after the close (**4:30 PM ET**) and is **EOD-only** — it does not update intraday.

#### How to use the three views

**1 · Extension Matrix** — the main view. Stocks are laid out left-to-right by extension bucket (−5x … 11x), each column header carrying a mini-histogram of how crowded that bucket is. Read it left-to-right: names on the **left (ENTRY, 0–4x)** are fresh, un-stretched entries; names on the **right (7x+)** are overextended — manage, don't chase. Click a column header to isolate that bucket; click any chip to open it on TradingView; hover for full stats (ATR, RS, structure, suggested stop, scale-out ladder).

**2 · RTS Matrix** — the same stocks sorted by **grade** (A+ → G−) into Strong / Transitional / Weak bands. This is the quality lens: which names have the best trend structure and relative strength, regardless of extension. Strongest RS sits at the top of each grade column.

**3 · Positions** — a personal tracker stored **in your browser only** (nothing is sent to the server). Add a ticker, entry, shares, and stop; it shows live P&L in R-multiples and %, the current zone, your stop, and a **scale-out ladder** — the price levels where the stock would reach 7x/8x/9x/10x/11x extension (i.e., where to trim).

#### Two breadth reads — don't confuse them

- **Market Posture** (top strip) — *whole-index* breadth for the **S&P 500 + Nasdaq 100**: % above the 50/200-day, advancers vs decliners, and a **RISK-ON / MIXED / RISK-OFF** verdict. The "*should I be trading at all today?*" tone-setter.
- **This screen · above SMA50** (bar under the stat cards) — breadth of *only the scanned names*. Because the screen pre-filters for uptrends it runs ~90%+, so it is **not** a market-health read.

#### Morning Focus

The curated "best to buy" shortlist: `buy` action, 0–4x extension, above-average ATR-RS, least-extended first. **These are prep for the next session's open**, built from the prior close (the date is shown on the panel) — an EOD watchlist to confirm at the open, not a live/intraday list. **copy $tickers** pastes the list into TOS / TradingView.

#### As a daily workflow

1. **Market Posture** — RISK-ON? Entries have a tailwind. RISK-OFF? Tighten up or sit out.
2. **Morning Focus** — your shortlist of clean entries for the next open.
3. **Extension Matrix** — scan the ENTRY (0–4x) columns for A/B-grade, `buy`-action names; avoid the 7x+ right side.
4. **RTS Matrix** — sanity-check quality; prefer A/B over D/E at the same extension.
5. **Positions** — track what you took; watch the scale-out ladder for where to trim.

### 5 · Performance

Every Bull List entry is treated as a paper trade with **$5,000 notional** (qty = floor(5000/entry)). Closed trades are aggregated into win rate, total P&L, average P&L, best/worst %, and breakdowns by source. The day-trade alert log is shown alongside.

> Day-trade alerts are not yet auto-tracked as paper trades — they're recorded as a log. Adding live entry/SL/TP for day trades is on the v2 list.

### 6 · About

What you're reading. Sourced from `docs/ABOUT.md` in the repo and rendered via `react-markdown` at build time. Push to `main` → SWA rebuilds → this page reflects the change automatically.

---

## Architecture

```
┌──────────────────────────────┐
│  Azure Functions (Node 20)   │
│  - avwapEodTimer  (4:15 PM)  │
│  - atrEodTimer    (4:30 PM)  │
│  - bullEmailTimer (hourly)   │
│  - bullMonitorTimer (30 min) │
│  - breadth (on-demand gauge) │
│  - HTTP read endpoints       │
└──────────────┬───────────────┘
               │
       ┌───────┴────────────┬─────────────────┐
       ▼                    ▼                 ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│ Azure Tables │   │ Azure Queue  │   │ Polygon.io       │
│ AvwapResults │   │ whatsapp-    │   │ Outlook IMAP     │
│ BullList     │   │ alerts       │   │ Gmail SMTP       │
│ AlertLog     │   └──────┬───────┘   └──────────────────┘
└──────────────┘          │
                          ▼
                 ┌──────────────────┐
                 │ Local sidecar    │
                 │ whatsapp-web.js  │
                 └──────────────────┘
```

## Cron schedule (`mtfrev-cron` Function App)

| Job                  | Schedule (ET)                | Endpoint                                   |
|----------------------|------------------------------|--------------------------------------------|
| AVWAP EOD            | 16:15 weekdays               | `POST /api/avwap-eod-timer`                |
| Bull email poll      | every hour                   | `POST /api/bull-email-timer`               |
| Bull monitor         | every 30 min, 9:00–16:30     | `POST /api/bull-monitor-timer`             |
| **ATR Matrix EOD**   | **16:30 weekdays**           | `POST /api/atr-eod-timer`                  |

All timers require the `x-timer-secret` header matching the `TIMER_SECRET` env var. The **Market Posture** breadth gauge is computed on demand (`GET /api/breadth`, ~10-min cache) — no cron. Day-trade reversal alerts are now produced by a local Finviz→TOS→OCR scanner that POSTs to `/api/scanner-alert`. All "today" date stamps use the **Pacific** calendar date.

## Stack

- **Frontend**: React 19 + Vite 6 + Tailwind 4
- **Backend**: Azure Functions v4 (Node 20, CommonJS)
- **Storage**: Azure Table Storage + Azure Storage Queue
- **Data**: Polygon.io (OHLCV, last trade)
- **Email**: Outlook IMAP (in), Gmail SMTP (out)
- **Alerts**: WhatsApp via whatsapp-web.js sidecar, Pushover fallback
- **Hosting**: Azure Static Web Apps (Free tier)
