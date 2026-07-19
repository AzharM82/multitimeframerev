# NextGen Trading Portal — spec (PARKED 2026-07-19)

Not started. Captured verbatim from the user's spec, plus feasibility notes gathered
while the context was fresh. Read the notes before estimating — one of them
determines whether half the feature is buildable at all.

---

## Part 1 — Core app

Day-trading tab: enter a ticker, run live analysis. Acts as a strict risk manager
and trading coach.

### 1. Dynamic Risk Allocation Calculator
- Asks for max daily stop loss; user independently grades the setup A+ / A / B / C.
- Allowable capital risk = percentage of the daily stop, by grade:
  | Grade | Allocation | Frequency |
  |---|---|---|
  | A+ | **80%** | rare — heavy volume, fresh catalyst |
  | A  | **30%** | 1–2 times a week |
  | B  | **15%** | a few times a day |
  | C  | **5%**  | very common, ~50/50 win rate |

### 2. Tape Reading Confirmation
Logic engine monitoring four Level 2 / Time & Sales signals:
1. **Size on the offer thinning** — large asks being eaten through, available size dropping fast
2. **Sweep orders** — single massive market orders clearing multiple price tiers instantly
3. **Bids stacking** — large bids appearing below price during pullbacks
4. **Print speed accelerating** — rolling trades-per-second spiking

- **3 or 4 signals** → green "Tape is Confirming", clear to enter
- **≤2 signals** → strict warning: sellers in control / EV not expanding; do not enter or size up

### 3. Live Position Warnings & Habit Enforcement
Live dashboard while holding:
- **10:25 AM Fade Alert** — scale out or tighten stops by 10:25 on morning momentum trades; momentum statistically dies/reverses after 10:30
- **Resistance Front-Running** — sell 50% exactly 10¢ before major resistance; first test rejects ~68% of the time
- **Three Red Bar Rule** — three consecutive red bars after a strong run, and the third bar's high isn't immediately taken out → reduce size
- **Anti-Averaging-Down Lock** — adds permitted ONLY when the trade is confirming thesis and EV is expanding; averaging down strictly forbidden
- **Zen Mode (P&L hider)** — hide open P&L during the trade to avoid the loss-aversion response shutting down rational decisions

---

## Part 2 — Advanced automation

### 1. Automated setup grading via vision LLM
Feed a vision-capable LLM the daily and 10-minute charts (or raw price-action data).

- **Macro context (daily):** distinguish "day-two breakout on a fresh catalyst with
  heavy volume" (high EV) from "day-seven extended move on declining volume with no
  new information" (a trap)
- **Intraday context (10-min):** breakout, failed breakout of a range, or trend continuation
- **Output:** the grade, its allocation, and the reasoning — weighting **volume and
  context over chart pattern**

### 2. Automated tape reading via Thinkorswim Level 2
Stream L2 order book + Time & Sales; continuously score the four signals above.
Rolling score → green light at 3-of-4, warning at ≤2.

---

## Feasibility notes (gathered 2026-07-19 — read first)

**⚠️ The tape-reading half depends on market-data access this portal does not have.**

1. **Polygon plan has NO real-time entitlement.** Verified this session: `/v2/last/trade`
   and `/v3/quotes` both return `NOT_AUTHORIZED`, and the snapshot response omits
   `lastTrade`/`lastQuote` entirely. Quotes are ~15 minutes delayed. **Tape reading is
   impossible on delayed data** — all four signals are sub-second phenomena. Polygon is
   a non-starter for Part 2.2 without a plan upgrade to a real-time tier (and L2 depth
   is a separate, higher tier again).

2. **"Thinkorswim API" needs pinning down.** TOS has no public streaming API. The
   Schwab API (Schwab acquired TOS) is the real target — and there IS existing Schwab
   integration in this ecosystem: see the StockAgentHub notes re: the 7-day token
   re-auth cycle. Open questions before committing: does that plan expose full L2 depth
   (not just NBBO), and does it stream Time & Sales? If only NBBO is available,
   signals 1 and 3 (offer thinning, bids stacking) cannot be computed.

3. **Streaming does not fit the current architecture.** The portal is Azure Static Web
   Apps + HTTP-triggered Functions — request/response, no persistent connections,
   5-minute execution cap. A continuous L2 stream needs either a local sidecar (like
   the existing WhatsApp sidecar / OCR scanners on DESKTOP2) or a separate always-on
   service. It cannot live in the SWA managed API.

4. **Vision grading is straightforwardly feasible.** Claude API with vision handles
   Part 2.1. The input question is whether to send rendered chart images or raw OHLCV
   — raw data is cheaper and more deterministic; images capture what the user actually
   sees. Worth prototyping both.

5. **Part 1 alone is genuinely useful and has no data dependency.** The risk
   calculator, the habit enforcement rules, and Zen Mode are pure client-side logic —
   buildable immediately, no market data, no streaming. A sensible first slice: ship
   Part 1 with manual signal checkboxes for the tape, then automate the tape later if
   the Schwab data access turns out to exist.

6. **Prior art worth reusing:** the deleted Tools tab had a position sizer
   (`useSizer.ts`, min-of-risk-and-capital-constrained) verified against three legacy
   calculators — recoverable from git history at commit `fde9468` if the risk
   calculator wants it.
