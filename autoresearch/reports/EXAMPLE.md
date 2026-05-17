# autoresearch 2026-W20 (EXAMPLE — fabricated, illustrative only)

> **This is a mock report** showing the format you'll see each Sunday.
> All numbers below are made up; the agent has not actually run yet.
> Replace once the first real round completes.

## TL;DR

Drop signals fired in the first 10 minutes after the open (06:30–06:40 PT).
That window has the worst signal quality across the cached history —
removing it lifts **expected P&L per signal from -$0.42 → +$3.18** on
the val split (n=42) without reducing trade count below useful levels.

## Hypothesis

Open-bar reversals are dominated by gap-fill noise rather than genuine
trend reversals; the 5/15 timeline shows a wave of 06:30 prints that
all reverted by EOD. A simple time-of-day filter should remove them.

## Change

```diff
--- a/strategy.py
+++ b/strategy.py
@@ def should_take(alert: Alert) -> bool:
-    return True
+    # Skip the chaotic first 10 minutes — high freq of fakeouts on the open.
+    et_min = (alert.firedAt.astimezone(ET).hour * 60
+              + alert.firedAt.astimezone(ET).minute)
+    if 9 * 60 + 30 <= et_min < 9 * 60 + 40:
+        return False
+    return True
```

(Full diff in commit `7a3f2c1`.)

## Metrics

|                | Baseline | This commit | Δ |
|---|---|---|---|
| **metric (val)** | **+0.0042** | **-0.0032** | -0.0074 ↓ |
| expected_pnl (val) | -$0.42 | +$3.18 | +$3.60 |
| win_rate (val) | 47.6% | 54.8% | +7.2 pp |
| n_trades (val) | 47 | 42 | -5 |
| profit_factor (val) | 0.93 | 1.31 | +0.38 |
| expected_pnl (train) | +$0.11 | +$2.85 | +$2.74 |
| profit_factor (train) | 1.04 | 1.42 | +0.38 |

Exits shifted toward TP (was 38% / 42% / 20% TP/SL/EOD → 41% / 33% / 26%).

## Side effects

- Mean holding-time increased ~6 min — entries later in the morning
  reach targets faster than open-bar entries that grind.
- 5 alerts dropped on val; on train 18 dropped. Coincides with the
  spike of 9:30–9:35 ET prints visible in 5/15 and 5/13.

## Trials this round

|  # | commit  | metric | val_n | status | description |
|---:|---|---:|---:|---|---|
|  1 | 7a3f2c1 | -0.0032 | 42 | **keep** | drop 9:30–9:40 ET window |
|  2 | b4d11de | -0.0009 | 38 | discard | also drop 9:40–9:45 (over-trimmed) |
|  3 | e2a7901 | +0.0061 | 47 | discard | TP at 2.5%, SL at 1.2% |
|  4 | 3c91482 | +0.0040 | 47 | discard | scale size by 1/bars_ago |
|  5 | 6ff0bc3 | -0.0028 | 42 | discard | combine (1) + (3) — only marginal vs (1) alone |
|  6 | 8a99e15 | +0.0050 | 47 | discard | filter on relative volume > 1.5 |
|  7 | f1b022a | -0.0031 | 42 | discard | drop 9:30–9:42 (extra 2 min didn't help) |

7 trials run, 1 kept. Time budget exhausted at trial 7 (3h 28m).

## What to try next round

The cleanest improvement on the validation split came from a hard time
gate. Worth probing **other suspect windows** (e.g. 12:30–13:00 ET
lunch-time chop, or last 30 minutes of session) and **ticker-quality
filters** (price > $30 floor seemed mildly positive at trial 4 before
the metric was diluted by sizing noise — isolate it next round).

The OCR sanity threshold (currently ±20% in tos-reversal-scanner) was
not exercised this round; backtest sees only post-OCR data so testing
it requires extending evaluate.py to replay raw OCR — out of scope
for one round, flag for a future infra change.

---

**Diff applied (manual review required):**
- `mtf-autoresearch` PR #12 — adds the time filter to `strategy.py`.
- No `tos-reversal-scanner` change recommended this week.
