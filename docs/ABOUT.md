# MTF Reversal — How it works

This site replaces five disconnected scanners with a **swing-trade-first** system built around four moving parts. The whole pipeline is owned by the user — no third-party scanners, no SaaS subscriptions beyond Polygon.io for market data and Outlook/Gmail for email.

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

### 4 · Performance

Every Bull List entry is treated as a paper trade with **$5,000 notional** (qty = floor(5000/entry)). Closed trades are aggregated into win rate, total P&L, average P&L, best/worst %, and breakdowns by source. The day-trade alert log is shown alongside.

> Day-trade alerts are not yet auto-tracked as paper trades — they're recorded as a log. Adding live entry/SL/TP for day trades is on the v2 list.

### 5 · About

What you're reading. Sourced from `docs/ABOUT.md` in the repo and rendered via `react-markdown` at build time. Push to `main` → SWA rebuilds → this page reflects the change automatically.

---

## Architecture

```
┌──────────────────────────────┐
│  Azure Functions (Node 20)   │
│  - avwapEodTimer  (4:15 PM)  │
│  - bullEmailTimer (hourly)   │
│  - bullMonitorTimer (30 min) │
│  - dayTradeTimer  (10 min)   │
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

## Cron schedule (cron-job.org)

| Job                  | Schedule (ET)                | Endpoint                                   |
|----------------------|------------------------------|--------------------------------------------|
| AVWAP EOD            | 16:15 weekdays               | `POST /api/avwap-eod-timer`                |
| Bull email poll      | every hour                   | `POST /api/bull-email-timer`               |
| Bull monitor         | every 30 min, 9:30–16:00     | `POST /api/bull-monitor-timer`             |
| Day-trade scan       | every 10 min, 9:30–15:30     | `POST /api/day-trade-timer`                |

All timers require the `x-timer-secret` header matching the `TIMER_SECRET` env var.

## Stack

- **Frontend**: React 19 + Vite 6 + Tailwind 4
- **Backend**: Azure Functions v4 (Node 20, CommonJS)
- **Storage**: Azure Table Storage + Azure Storage Queue
- **Data**: Polygon.io (OHLCV, last trade)
- **Email**: Outlook IMAP (in), Gmail SMTP (out)
- **Alerts**: WhatsApp via whatsapp-web.js sidecar, Pushover fallback
- **Hosting**: Azure Static Web Apps (Free tier)
