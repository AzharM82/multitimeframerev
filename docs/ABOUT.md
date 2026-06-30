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

**Action signal** (the chip's left-border color): `sell` (below 50-day) · `reduce` (below 20-day) · **`buy`** (structure ≥ 5, 0–4x extended, above-average ATR-RS) · `hold`.

**Setup score (0–100).** A single composite that blends the four swing-entry factors so the strongest combinations sort to the top: **extension proximity** to the ideal entry (peaks near 1.5x, penalized below SMA50 / when extended) 30%, **structure** 25%, **RS** 25%, **RVOL** (relative volume — today's volume ÷ its average, volume confirmation) 20%. Every chip's **background fills green (≥ 50) → red (< 50)** by this score; 🔥 marks RVOL ≥ 2×.

**Universe.** The **whole S&P 500 + Nasdaq 100** (~500 names), pulled once after the close (**4:30 PM ET**) from the Finviz Elite columns — price, ATR, the 20/50/200-day SMA distances, performance returns, volume — so the entire matrix is computed from two API calls with **no per-stock price fetching**. This is a *true map*: every zone from LEAVE to BLOW-OFF is populated and breadth is real (not a pre-filtered uptrend list). The scan is **EOD-only** (it does not recompute intraday — see Top Setups → go live for that). Toggle **trending candidates** to re-apply the old swing screener (mid-cap+, price > $10, avg vol > 750K, ATR > 1.5, weekly vol > 3%, SMA20 > SMA50 > SMA200) within the universe.

#### How to use the four views

**1 · Top Setups** *(default)* — a flat list of the whole universe **ranked by setup score**, with score / action / zone / grade / RS / ATR-RS / RVOL / price / change / change-from-open columns. **Click any header to sort.** Hit **go live** during market hours and it polls live prices every 45s and tags each name's **intraday tradability**: 🟢 **BUYABLE** (broke the prior-day high, or green & holding SMA20) · 🟡 **SETTING UP** · ⚪ **WAIT** · 🔴 **BROKE** (lost SMA50). This is the bridge from "good EOD candidate" to "take it now."

**2 · Extension Matrix** — stocks laid out left-to-right by extension bucket (−5x … 11x), each column header carrying a mini-histogram. Names on the **left (ENTRY, 0–4x)** are fresh entries; names on the **right (7x+)** are overextended. Within each column, best setup score is on top. Click a header to isolate a bucket; click a chip for TradingView; hover for full stats.

**3 · RTS Matrix** — the same stocks by **grade** (A+ → G−) into Strong / Transitional / Weak bands — the quality lens, sorted by setup score within each grade.

**4 · Positions** — a personal tracker stored **in your browser only**. Entry / shares / stop → live P&L in R-multiples and %, the current zone, and a **scale-out ladder** (prices where extension reaches 7x…11x — where to trim).

**Reverse lookup** — type any ticker in the search box and press **Enter** for a full detail card (works for any symbol, not just the universe — off-universe names are fetched live and ranked against the S&P 500 + Nasdaq 100).

#### Two breadth reads — don't confuse them

- **Market Posture** (top strip) — *whole-index* breadth for the **S&P 500 + Nasdaq 100**: % above the 50/200-day, advancers vs decliners, and a **RISK-ON / MIXED / RISK-OFF** verdict. The "*should I be trading at all today?*" tone-setter — it also sets the Focus panel's default buy/sell bias.
- **Shown names · above SMA50** (bar under the stat cards) — breadth of just the currently-filtered view.

#### Focus (buy *or* sell)

A shortlist for the next session's open, built from the prior close. A **BUY / SELL toggle** defaults from index breadth (RISK-OFF → sell bias) — buy mode lists `buy`-action, 0–4x, above-avg-ATR-RS names **ranked by setup score**; sell mode lists the below-SMA50 breakdowns to exit/avoid. Selecting an action in the **action filter** drives the list too. **copy $tickers** pastes it into TOS / TradingView.

#### As a daily workflow

1. **Market Posture** — RISK-ON? Entries have a tailwind. RISK-OFF? Flip Focus to sell / sit out.
2. **Top Setups** — the ranked shortlist; turn on **trending candidates** + **action: buy** to narrow to the cleanest names.
3. Next morning, **go live** — take the ones that flip 🟢 BUYABLE as they trigger.
4. **Positions** — track what you took; watch the scale-out ladder for where to trim.

### 5 · Catalyst Value Eval

A prop-desk **Catalyst Value Equation (CVE)** scanner: it grades the day's biggest movers by *why* they are moving, not just how much. The equation is **CVE = Magnitude × Speed**.

- **Magnitude** — how big is the shift in perceived company value? Rated **Absolute** (structural, forced-flow — e.g. an index addition where passive funds must buy), **Yes** (a confirmed real shift — FDA approval, earnings beat, M&A, multiple upgrades), **Maybe** (a partial catalyst or confirmation of an existing thesis), or **No** (no catalyst, or merely the *absence of an expected positive*).
- **Speed** — how fast must the market act? **Absolute** (a hard mechanical deadline like an index-rebalance date), **Yes** (high urgency / snapback — institutions must reprice today), **Maybe** (slow, multi-year digestion), or **No** (no timeline, drifts over weeks).

The two ratings multiply into a grade and a daily-stop allocation:

| Magnitude × Speed | Grade | Daily stop |
|---|---|---|
| Absolute × Absolute | **A+** | 80% |
| Yes × Yes | **A** | 30% |
| Yes × Maybe / Maybe × Yes | **B** | 15% |
| Maybe × Maybe | **C** | minor |
| any "No" | **D** | 0% — filtered out |

Catalysts are classified **Fundamental** (earnings, FDA, M&A, products), **Technical** (index add/remove, lockups, options listings), or **Combination** (both at once). For bearish names the engine demands a *true negative catalyst* (surprise miss, product failure, regulatory action) — a drop that is only the absence of an expected positive scores **No** on Magnitude and is filtered.

The universe is the day's in-play names: **FinViz Elite pre-market gappers** + **Polygon gainers/losers** + tickers in the last 24h of **Polygon market news**. Per-ticker news (with Polygon's sentiment insights) drives the scoring. It runs twice daily — **15 minutes before the open** and **15 minutes before the close** — and emails + Pushover-pushes the top 3 positive and top 3 negative B/A/A+ catalysts, each with its Magnitude × Speed = Grade line, suggested stop %, and a generated commentary. The email is the same tabular view you see on this tab.

### 6 · Performance

Every Bull List entry is treated as a paper trade with **$5,000 notional** (qty = floor(5000/entry)). Closed trades are aggregated into win rate, total P&L, average P&L, best/worst %, and breakdowns by source. The day-trade alert log is shown alongside.

> Day-trade alerts are not yet auto-tracked as paper trades — they're recorded as a log. Adding live entry/SL/TP for day trades is on the v2 list.

### 7 · About

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
| **CVE — pre-open**   | **09:15 weekdays**           | `POST /api/cve-timer?phase=open`           |
| **CVE — pre-close**  | **15:45 weekdays**           | `POST /api/cve-timer?phase=close`          |

All timers require the `x-timer-secret` header matching the `TIMER_SECRET` env var. The **Market Posture** breadth gauge is computed on demand (`GET /api/breadth`, ~10-min cache) — no cron. Day-trade reversal alerts are now produced by a local Finviz→TOS→OCR scanner that POSTs to `/api/scanner-alert`. All "today" date stamps use the **Pacific** calendar date.

## Stack

- **Frontend**: React 19 + Vite 6 + Tailwind 4
- **Backend**: Azure Functions v4 (Node 20, CommonJS)
- **Storage**: Azure Table Storage + Azure Storage Queue
- **Data**: Polygon.io (OHLCV, last trade)
- **Email**: Outlook IMAP (in), Gmail SMTP (out)
- **Alerts**: WhatsApp via whatsapp-web.js sidecar, Pushover fallback
- **Hosting**: Azure Static Web Apps (Free tier)
