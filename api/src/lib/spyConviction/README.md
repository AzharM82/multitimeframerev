# SPY Conviction Score — receiver

TradingView alert sink for the six-leg 10-minute SPY indicator. Replaced the
5-min breadth-streak + Gate-regime system on 2026-08-12.

**Non-goals, deliberately.** No broker. No orders placed, routed, staged or
simulated. No position sizing, no risk maths. This receives, authenticates,
validates, records and notifies — nothing else.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/spy-conviction` | alert sink |
| `POST` | `/api/tv-trend-webhook` | the same sink, under the URL already in TradingView |
| `POST` | `…?flat=1` | force the believed position back to FLAT (portal session or timer secret) |
| `POST` | `…?report=1` | store the EOD research report (timer secret) |
| `GET`  | `…` | audit + state for the tab (portal session or timer secret) |

Both POST routes are live permanently. Retiring the old one would mean re-pasting
every TradingView alert, and an alert pointing at a dead URL fails **silently** —
which from a phone is indistinguishable from a quiet market.

## The alert TradingView sends

Message body is the indicator's JSON. Add a `secret` field matching
`TV_WEBHOOK_SECRET`, or append `?token=<secret>` to the URL — TradingView cannot
send custom headers, so it has to be one or the other. The body is preferred; a
URL ends up in logs.

```json
{
  "strategy": "SPY_CONVICTION", "secret": "…",
  "signal": "BUY_PUT", "action": "BUY", "side": "PUT",
  "grade": "STRONG", "bias": "downside", "score": -67, "legs_agree": 6,
  "entry_trigger": "vwap_reclaim", "entry_dist_atr": 0.12, "ext_atr": -0.44,
  "bars_held": 0, "entry_score": -67, "entry_px": 770.45, "block_reason": "none",
  "spy": 770.45, "vwap": 771.64, "ema9": 770.98, "atr": 0.83, "vix": 15.33,
  "tick": -36, "cvd": -90000, "breadth_ratio": 3.491,
  "tf": "10", "chart_symbol": "SPY", "bar_time": "2026-08-12 09:50:00"
}
```

Only `signal`, `action` and `bar_time` are required. Everything else degrades to
"not shown". **Unknown fields are carried, never rejected** — the indicator will
gain columns, and a new field must not take the feed down.

## Behaviour worth knowing

**A malformed body returns 200, not 4xx.** TradingView disables an alert that
keeps erroring; a strict rejection would silence the feed for the rest of the
session over one bad message. It is tagged `deadletter` in the hit log instead,
where the tab shows it.

**A bad secret returns 401 and is not dead-lettered.** That is not TradingView
getting it wrong, it is someone else knocking.

**Duplicates drop on `(strategy, bar_time, signal)`.** TradingView retries; a
retry must not notify twice.

**Out-of-order transitions are flagged, never fatal.** `SELL_PUT` while flat is
recorded as an anomaly, counted, and banner-ed on the tab — the receiver keeps
running, because one that rejects the unexpected loses every message after it.

**Only `ARM`, `BUY`, `REDUCE`, `SELL`, `CANCEL` notify.** `HOLD` and
`STAND_ASIDE` stay silent: on 10-minute bars they fire all session and would
train the operator to ignore the channel.

**`withinRth` comes from the BAR, not the request.** Judging it by arrival marks
a retried or backfilled alert as overnight even though its bar sat mid-session.

## Position lifecycle

```
STAND_ASIDE ──► ARM_CALL/ARM_PUT ──► BUY_* ──► HOLD_* / REDUCE_* ──► SELL_* ──► flat
                       │
                       └──► ARM_CANCEL ──► flat
```

`STAND_ASIDE` is legal from any state and always lands FLAT — it is the
indicator's idle heartbeat, and the indicator is authoritative about its own
state. Arriving while a position is believed open is still an anomaly, because
it means an exit went missing.

The state is a **belief**: the operator trades by hand and may skip one. It
resets at the start of each ET session on read, and `?flat=1` corrects it.

## Tests

```
cd api && npm run build
node tools/spy-conviction-check.mjs   # parser + state machine, 23 cases
node tools/spy-conviction-e2e.mjs     # against a running `swa start`, 16 cases
node tools/spy-conviction-seed.mjs    # post a realistic session; --clean removes it
```

The parity check mirrors `dev/spy-conviction/tests/test_webhook.py`, the Python
reference this was ported from, case for case.

## Shadow ledger (2026-09-05)

The sink above never trades. A sibling module, `api/src/lib/spyShadow/`, scores every
accepted BUY after the close against one fixed rule (2-min 9 EMA pullback within 10 min,
+20% target, −9% stop checked first, else the close, $2,000 all-in, commission 0) and keeps
the result in `SpyShadowTrades`. Rule, data, endpoints, backtest history and the decision
log are in the repo README under "SPY Conviction — alerts, the shadow ledger, and How it
works"; the operating rules are in CLAUDE.md under "SPY Conviction shadow ledger".
