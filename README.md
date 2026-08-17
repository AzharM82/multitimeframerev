# Multi-Timeframe Reversal (MTF portal)

Swing and day-trade scanner suite. React 19 + Vite 6 + Tailwind 4 front end,
Azure Functions v4 API (Node 20, CommonJS), deployed as one Azure Static Web App.

**Live:** https://salmon-river-0a7a0c30f.1.azurestaticapps.net
**Azure:** SWA `mtfrev-app`, RG `rg-mtfrev`. Cron timers live in a *separate*
Function App, `mtfrev-cron`.

> `CLAUDE.md` is the file the Claude CLI auto-loads and is the operational
> source of truth for build/validate/deploy rules. This README is the wider
> orientation: what exists, how the pieces fit, and the things that have already
> gone wrong so they need not go wrong twice.

---

## Tabs

| Tab | Hash | What it is |
|---|---|---|
| Gate | `#gate` | YES/CAUTION/NO trading-quality score |
| Sector Desk | `#desk` | Which sector group is running + liquid names in it |
| ATR Matrix | `#atr` | EOD ATR-to-SMA50 extension matrix |
| **AVWAP from Earnings** | `#avwap` | **Four chart levels across the MASTER watchlist — see below** |
| Catalyst Value Eval | `#cve` | Magnitude x Speed catalyst grading |
| Rotation | `#rotation` | Market → sector → industry → stock tree, FinViz real-time |
| Chart Analysis | `#chart` | Single-ticker weighted read off TradingView desktop |
| Opening Drive | `#opening` | SMB PMH-break tracker |
| SPY Conviction | `#spy` | Six-leg 10-min SPY indicator, alerts-only |
| Journal | `#journal` | SnapTrade fills + dictated notes + rolling lessons |
| About | `#about` | — |

---

## AVWAP from Earnings — the newest and most involved subsystem

Built 2026-08-15/16. Worth reading before touching anything in it.

### What it does

Every 39-minute candle close, a publisher on a second machine sweeps the
**MASTER** TradingView watchlist (193 symbols) and reports how far price sits
from **four levels**, all **read off the operator's own chart studies** rather
than recomputed:

| Level | Source study | Note |
|---|---|---|
| `avwap` | `VWAP Auto Anchored`, Anchor Period = **Earnings** | 39m chart |
| `sma50` | standalone `Simple Moving Average`, length 50 | **FIVE trading days.** A 390-min session = 10 bars of 39m, so 50 bars = one week of candles. *Not* the 50-day SMA — they sat ~7.6 apart on MXL |
| `ema21d` | EMA 21 on **1D**, from the `Moving Averages HTF` overlay | daily line drawn on the 39m chart |
| `sma50d` | SMA 50 on **1D**, same overlay | |

```
pct = (close - level) / level * 100      (+ above / - below)
```

### Alert rules

| Event | Condition | Levels |
|---|---|---|
| `CROSS_UP` | the candle **closes** above the level, previous candle closed below | all four |
| `TOUCH_DOWN` | a name extended **above** the AVWAP comes back down and touches it | AVWAP only |

Guards: a **0.25% deadband** on the previous candle (`AVWAP_CROSS_MIN_PCT`), and
dedup keyed on `ticker + level + direction + BAR`.

### Data flow

```
DESKTOP2  TradingView Desktop (CDP :9222)
   |      tools/tv-avwap/publish_avwap.mjs   (Task Scheduler, per candle close)
   v
POST /api/avwap-earnings   (x-timer-secret; POST-only anonymous in staticwebapp.config.json)
   |
   v
Azure Table AvwapEarnings
   current/<TICKER>          latest read per symbol
   current/__meta__          bar, publisher, failed[]
   <YYYY-MM-DD>/<t>-<tkr>-<lvl>   history, written ONLY on a cross
   alert-<BAR ET DATE>/<tkr>-<lvl>-<dir>-<barTime>   dedup
   |
   +--> notifyBoth()  ->  Pushover + WhatsApp queue -> sidecar on DESKTOP2
   |
   v
GET /api/avwap-earnings   (portal-role gated) -> src/views/AvwapEarningsPage.tsx
```

`GET` also joins **FinViz Elite** quotes (`fetchQuotesFinviz`, 30s cache) for the
Chg % and From Open columns, so those agree with Rotation and Sector Desk.
Non-fatal: if FinViz is down those two columns blank and the levels still render.

### Schedule

One sweep per **39-minute candle close**, not a round-number grid. RTH closes are
07:09, 07:48, 08:27, 09:06, 09:45, 10:24, 11:03, 11:42, 12:21, 13:00 PT. The task
starts **06:31** and repeats every **39 min** for **7 hours** — one minute after
each close, plus an at-the-open snapshot. Ten scored closes a session.

Do **not** set it to 06:30: that lands every run exactly on a close with zero
settle margin. Do **not** shorten the duration to 6h: from 06:31 that stops at
12:31 and the session's final bar is never scored.

Sweep timing on DESKTOP2: **~133s warm, ~300s cold** (cold = first run after a
TradingView restart). `ExecutionTimeLimit` is PT9M.

### The two machines

- **DEV (this repo's usual host)** — owns the cloud and the portal. Builds,
  tests, deploys, verifies.
- **DESKTOP2** — owns TradingView. Runs the publisher. *All* TradingView reads
  belong here; do not drive charts from DEV.

They coordinate through `tools/bigdog-scanner/OPS_HANDOFF.md`, committed to
`main`. DESKTOP2 polls it every ~5 minutes and prefixes its commits
`ops(desktop2):`. Keep **exactly one** open `[ ]` item — it works the topmost
unchecked one, so a stack of overlapping items is actively harmful.

**Before writing an instruction for DESKTOP2, check it can actually run it.**
It cannot: self-elevate (so no `Register-ScheduledTask` / `Disable-ScheduledTask`),
edit `.env` (secrets classifier), or make an outward network write carrying
`TIMER_SECRET` (so the interactive `publish_avwap.mjs --force` needs the
operator; the *scheduled* task does it unattended). Three separate instructions
were written that it had already said it could not perform. When you hit one of
these, **remove the dependency** rather than escalate it — that is why
`PUBLISHER_ID` reads `publisher_id.txt`, a non-secret file the machine can write
itself.

---

## Build, run, test

```bash
npm ci && (cd api && npm ci)

npm run build                 # tsc -b && vite build && copies staticwebapp.config.json into dist/
cd api && npm run build       # tsc -> api/dist

npx swa start dist --api-location api      # http://localhost:4280
```

`api/local.settings.json` supplies POLYGON_API_KEY, AZURE_STORAGE_CONNECTION_STRING,
FINVIZ_API_KEY, TIMER_SECRET etc. **Never commit it.**

There is no unit-test suite for the portal; validation is manual E2E. The one
real test harness is the publisher's:

```bash
cd tools/tv-avwap && node test_chart_js.mjs      # 45 assertions, no browser needed
```

It evaluates the **real** `INSTALL` string against a fake chart built from the
actual study titles and value arrays read off the live layout, with
`getInputValues()` deliberately absent. Run it before pushing anything that
touches `chart_js.mjs`.

---

## Deploy

Merging a PR does **not** deploy. Deploy is explicit:

```bash
npm run build && (cd api && npm run build)
TOKEN=$(az staticwebapp secrets list --name mtfrev-app --resource-group rg-mtfrev --query properties.apiKey -o tsv)
npx swa deploy ./dist --api-location api --deployment-token "$TOKEN" \
  --env production --api-language node --api-version 20
```

**A change under `tools/` alone needs no deploy** — that code runs on DESKTOP2.
Check `git diff --name-only <base>..HEAD | grep -E '^(src/|api/src/|staticwebapp)'`
before assuming one is required.

After every deploy, verify the **live** site. A clean `swa deploy` exit says
nothing about whether the app works:

```bash
BASE=https://salmon-river-0a7a0c30f.1.azurestaticapps.net
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/health     # 200
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/breadth    # 200 (anonymous machine callers)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/avwap-earnings -d '{}'   # 401, NOT 302
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/avwap-earnings                   # 302 (portal-gated)
```

---

## Hard-won gotchas

**Wiring**
- A new Azure Function must be imported in the `api/src/app.ts` barrel or every
  route 404s.
- Machine-called routes need a **method-scoped** anonymous entry in
  `staticwebapp.config.json`, placed *before* the `/api/*` catch-all, or they 302
  to the login page.
- `staticwebapp.config.json` must land in `dist/` — `npm run build` copies it;
  do not bypass the script.
- API uses `module: Node16`: use `.js` extensions in imports.

**TradingView / the publisher**
- The CDP flag applies **only at launch**. A normally-launched TradingView can
  never be attached to. `setup_tv_launch_task.ps1` registers a logon task so a
  reboot cannot silently disable the publisher.
- AppX package name is `31178TradingViewInc.TradingView` — *not*
  `TradingView.Desktop`, which is the Application Id and resolves to nothing.
  Install from the Store (`winget install --id 9NDJWKSTBT25 --source msstore`).
- `getInputValues()` answers on `TradingViewApi.activeChart().getStudyById(id)`
  but returns **nothing** on the chart-model data source in Desktop 3.3.0.0.
  Study parameters are parsed from `title()` instead.
- Title parsing must split on **top-level commas only** — a naive `split(',')`
  tears `rgba(0, 0, 0, 1)` apart and shifts every argument after it.
- **Higher-timeframe plots are sparse**: a daily MA on a 39m chart carries a
  value only on the bar where the daily value lands. Requiring a value on both
  scored bars once rejected 100% of symbols. Levels are carried forward.
- `window.__avw*` **persists in the tab between runs**, so a half-installed build
  can keep answering with the previous build's helpers and look healthy. Hence
  `INSTALL_VERSION` / `window.__avwVersion`, asserted right after install.
- Alerts score the last genuinely **closed** bar, never the forming one. A
  forming 39m bar can sit above a level for half an hour and settle back under.

**Alerting**
- Dedup must be keyed **entirely off the bar**, both partition and row key. Using
  "today" for the partition meant the same bar scored on a later date looked
  un-alerted — which would have re-fired the previous session's crossings at the
  next open.

**Testing against production**
- `notifyBoth()` is wired to real Pushover and WhatsApp in production. **Any test
  POST that produces a crossing sends real alerts to a real phone.** Build probe
  payloads so a crossing is structurally impossible (`c_pct_* == p_pct_*`), and
  replay only levels that have already alerted. This has been got wrong twice.
- `swa start` against `api/local.settings.json` shares **production** storage.
  Clean up any rows a test writes.

**Windows**
- `.ps1` files must be pure **ASCII** (or UTF-8 with BOM). Windows PowerShell 5.1
  decodes BOM-less UTF-8 as ANSI, so an em dash corrupts string literals into
  genuine parse errors. Verify with
  `[System.Management.Automation.Language.Parser]::ParseFile($absPath, [ref]$null, [ref]$errs)`.
- `Register-ScheduledTask` raises a CIM error that `$ErrorActionPreference="Stop"`
  does **not** stop; verify with `Get-ScheduledTask` afterwards or the script
  reports success having done nothing.
- `az` is a `.cmd` wrapper: JMESPath **functions** in `--query` fail. Plain paths
  are fine.

---

## Conventions

- PR target `main`; branches `feat/<slug>` / `fix/<slug>`. Never push straight to
  `main` **except** `OPS_HANDOFF.md`, which is the live DESKTOP2 channel and is
  committed directly so it is seen within one poll.
- Never put secrets in `OPS_HANDOFF.md` — its history is permanent.
- Legacy v1 functions (scan, phaseScan, capitulation*, screener*) are dormant;
  do not wire new work into them.
