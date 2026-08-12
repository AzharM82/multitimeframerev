# streak-research — end-of-day agent for the SPY Conviction system

Replays each day's conviction signals against **real SPY option 5-minute bars**,
sweeps timing and instrument variants, and writes a report that renders under the
**SPY Conviction** tab (collapsible, below the day's decisions).

Runs **after the close**, locally — never against live data, and never in Azure.

*(The directory keeps its old name; it was repointed from the breadth-streak
system on 2026-08-12 rather than rebuilt. Renaming it would break the registered
scheduled task and the `research.env` sitting beside it, for no gain.)*

```
node research.mjs                     last completed session
node research.mjs --date 2026-08-12   a specific session
node research.mjs --dry-run           compute and print, push nothing
node research.mjs --portal http://localhost:4280
```

## What the variants actually vary

The indicator emits the decision — ARM, BUY, HOLD, REDUCE, SELL — so there are
no rules here to reimplement. What is left open is **when the operator acts on
it**, and that is what the sweep argues with: enter at the ARM or wait for the
BUY to trigger, exit at the first REDUCE or hold for the SELL, exit when the
score fades below a threshold, gate entries on score strength. A winner changes
the operator's timing, never the score.

## Why it lives here and not in the cloud

Same reason as `tools/journal-sync`: the interpretation step shells out to the
**Claude CLI** against the existing subscription, so no model key ever reaches
Azure. Azure only ever stores the finished report.

## Two rules the design will not bend on

**No model does arithmetic.** Every number comes from `simulate.mjs`, computed
from real bars. The model only ever reads the finished table. A model that is
also allowed to compute will eventually produce a confident figure nobody can
reproduce, and this exists to decide where real money goes.

**It reports; it never changes anything.** No auto-tuning of live rules. A
research agent with write access to trading behaviour is how a system drifts
without anyone deciding to.

## The sample-size gate

`MIN_TRADES = 20` **independent** entries — counted as `BUY_CALL`/`BUY_PUT` in
the raw stream, not summed across the sweep. An early version summed variant rows
and got 224 for a ten-signal day, which is the same handful re-priced 42 ways.

Below the threshold the agent still runs, in **mechanics-only** mode: the prompt
forbids ranking variants or drawing any performance conclusion. That mode has
already paid for itself five times over — four bugs in the simulator (an inflated
denominator, hold-through variants silently dropping their last open trade, a
"no-regime" variant still consulting the regime, forced closes filling at the
bar's open instead of its close), and on its very first conviction run, the
receiver deriving `withinRth` from the alert's *arrival* time instead of the
bar's, which mislabelled every backfilled alert as overnight.

Signals **cannot be backfilled** — the legs live on TradingView's side — and the
conviction cutover reset the clock on 2026-08-12, so the sample only grows
forward at a few entries a day.

## Data notes

- **Historical aggregates only.** Polygon's option *snapshot* endpoints are not
  entitled on this plan (403); the *aggregates* endpoints are. Since the agent
  runs post-close, aggregates are all it ever needs.
- **Option aggregates are rate-limited to ~5 requests/minute** (measured: 429 on
  the 6th call within a second). Calls are therefore *paced*, not retried, and
  bars are cached to `cache/` — a past session's bars never change, so a re-run
  costs nothing.
- **Fills** are the next 5-minute bar's **open** after a signal, bounded to
  10 minutes of slippage; beyond that the leg is reported unpriceable rather than
  pretending an illiquid contract filled. A forced end-of-day close fills at the
  last regular-hours bar's **close**.

## Setup

Copy `.env.example` to `research.env` (gitignored) and fill in `PORTAL_URL`,
`PORTAL_TIMER_SECRET` and `POLYGON_API_KEY`.
