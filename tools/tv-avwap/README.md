# AVWAP-from-Earnings publisher (runs on DESKTOP2)

Sweeps the **MASTER** TradingView watchlist on the **39-minute** chart and, per
symbol, reports how far price sits from three levels:

| Level | Source |
|---|---|
| **AVWAP** | the `VWAP Auto Anchored` study, **Anchor Period = Earnings** — chart truth, read off the same indicator the operator looks at |
| **21 EMA** | computed by the publisher from the 39m closes |
| **50 EMA** | computed by the publisher from the 39m closes |

```
pct = (close - level) / level * 100        (+ above / - below)
```

→ `POST {API_BASE}/api/avwap-earnings` (header `x-timer-secret`)
→ Azure table `AvwapEarnings`
→ portal tab **AVWAP from Earnings** (`#avwap`)

## Why the EMAs are computed here, not read off a study

The operator's 39m layout carries **daily** higher-timeframe MAs and a
195-period SMA — not 39m EMA 21/50. Adding studies to that shared chart would
make the sweep depend on chart configuration other tools also touch, and a
silently-wrong plot read is indistinguishable from a correct one. The bar series
is already in hand, so the EMAs are derived from it. Seeded with an SMA of the
first N closes (what TradingView does) and unit-tested for seeding, recurrence
and convergence.

## Live bar vs closed bar — the distinction that makes the alerts correct

Every row carries **two** readings:

- **live** (`close`, `pct_avwap`, `pct_ema21`, `pct_ema50`) — the forming bar.
  This is what the tab displays, so the tab shows price *now*.
- **closed** (`c_pct_*` and `p_pct_*`) — the last genuinely **closed** bar and
  the one before it. This is what the cloud decides alerts on.

The operator's rule is *"the candle **closes** above the level and the previous
candle was below"*. A forming 39m bar can sit above a level for half an hour and
settle back under it; scoring the live bar would fire alerts the closing print
never justified. The publisher decides which bar is closed from wall-clock time
against the bar's open plus the resolution, so the session's final bar is still
scored once it elapses rather than being skipped until the next day.

Deciding the cross from two adjacent **bars** rather than two successive
publishes also makes the result independent of how often this runs.

## Prerequisites on DESKTOP2

1. **TradingView Desktop must be LAUNCHED with the CDP flag.** The flag only
   applies at launch — an already-running app can never be attached to.
   Installed as an AppX package, so the path is version-stamped. The package
   **Name** is `31178TradingViewInc.TradingView` — `TradingView.Desktop` is the
   *Application Id* inside AppxManifest.xml and `Get-AppxPackage -Name
   TradingView.Desktop` returns nothing (verified on DESKTOP2, 2026-08-15):

   ```powershell
   $tv = (Get-AppxPackage -Name 31178TradingViewInc.TradingView).InstallLocation
   Start-Process "$tv\TradingView.exe" -ArgumentList "--remote-debugging-port=9222"
   ```

   If TradingView Desktop is not installed, install it from the **Store**
   (`winget install --id 9NDJWKSTBT25 --source msstore`) — the
   `TradingView.TradingViewDesktop` winget-source package is not an AppX and
   `Get-AppxPackage` will never see it.

   **The CDP flag does not survive a normal relaunch.** Any Start-Menu launch or
   reboot produces a TradingView with no debug port, and the publisher then exits
   2. Run `setup_tv_launch_task.ps1` to register a logon task that always starts
   it with the flag.

   Verify: `curl http://localhost:9222/json/version` answers. (Port-open ≠
   app-ready — `/json/list` can block for tens of seconds during tab restore.)

2. A chart tab on the **39m** layout with **VWAP Auto Anchored** visible, anchor
   set to **Earnings**. The publisher refuses to run otherwise.

3. `node --version` ≥ 22 (built-in `WebSocket` + `fetch`; no npm install needed).

4. `.env` filled in — copy `.env.example`.

## Install

```powershell
cd <repo>\tools\tv-avwap
copy .env.example .env      # then fill TIMER_SECRET and TV_CHART_URL
node publish_avwap.mjs --force --dry-run --limit 5     # smoke test, publishes nothing
node publish_avwap.mjs --force --dry-run               # full sweep, still publishes nothing
.\setup_tv_launch_task.ps1                             # elevated; TradingView with CDP at logon
.\setup_publisher_task.ps1                             # elevated; every 10 min during RTH
```

## Why this publisher is more careful than a read-only one

It **drives the chart symbol ~193 times over ~4 minutes**, so it carries guards
a passive chart reader does not need:

| Guard | What it prevents |
|---|---|
| **Lock file** (`.sweep.lock`) | Two sweeps, or a sweep and another chart driver, fighting over one chart. Stale locks (>15 min) are taken over. |
| **`TV_CHART_URL` binding** | Commandeering whatever chart happens to be bound. Pin it to a dedicated tab. |
| **Fail-closed preflight** | Publishing a sweep taken on the wrong timeframe or a non-earnings anchor. Wrong data is worse than no data. |
| **Symbol restore** | Leaving the chart parked on the last swept symbol. Runs even when the sweep throws. |
| **`failed[]` in the payload** | A dead feed looking exactly like a quiet market. Unreadable symbols are published by name and surfaced in the tab. |
| **Same-bar check** | Scoring price against a half-recomputed study. A read is accepted only when the study's bar *is* the price series' bar — for both bars scored. |

## Flags

| Flag | Effect |
|---|---|
| `--force` | Bypass the 9:25 AM–4:05 PM ET weekday gate |
| `--dry-run` | Sweep and print, publish nothing |
| `--limit N` | Only the first N symbols (smoke tests) |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Published (or dry-run / outside market window) |
| 1 | `TIMER_SECRET` missing |
| 2 | TradingView CDP unreachable or no chart target |
| 3 | Chart preflight failed |
| 4 | **Wrong chart** — resolution ≠ 39, or anchor ≠ Earnings |
| 5 | Watchlist not found or empty |
| 6 | Sweep produced no readable rows |
| 7 | Publish rejected by the cloud |
| 8 | Another sweep holds the lock |
| 10 | Unhandled error |

## Files

- `publish_avwap.mjs` — CDP transport, gating, payload, publish
- `chart_js.mjs` — the page-context expressions, kept separate so they can be
  exercised against a live chart independently of a publish cycle. These are the
  part most likely to break when TradingView changes their internals.
- `setup_publisher_task.ps1` — Task Scheduler registration for the sweep
- `setup_tv_launch_task.ps1` — logon task that launches TradingView **with** the
  CDP flag, so a reboot cannot silently disable the publisher

## Cadence

A full 193-symbol sweep measured **299.3s on DESKTOP2** (1.55s/symbol, market
closed). The task therefore runs every **10 minutes**, not 5: at a 5-minute
interval a 299s sweep finishes ~0.7s before the next fires, so any slowdown
overlaps and the loser exits 8 on the lock — "every 5 minutes" would not
actually be every 5 minutes.

10 minutes is ample for this signal. The alerts fire on **39-minute bar closes**,
so a bar can only produce a cross once every 39 minutes; a 10-minute cadence
still samples each bar ~4 times and detects any close-cross within 10 minutes of
the bar closing, with 2x headroom on the sweep itself.

## Alert rules (implemented in `api/src/lib/avwapEarnings.ts`)

| Event | Condition | Levels |
|---|---|---|
| `CROSS_UP` | candle closes above the level, previous candle closed below | AVWAP, 21 EMA, 50 EMA |
| `TOUCH_DOWN` | a name extended above the AVWAP comes back down and touches it | AVWAP only |

Guards: a **0.25% deadband** (`AVWAP_CROSS_MIN_PCT`) on the previous candle, so
a symbol parked on a level cannot spam; and dedup keyed on
`ticker+level+direction+bar`, so the same bar re-swept every 5 minutes alerts
once while a genuine later re-cross still alerts.
