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
| **SPY Conviction** | `#spy` | Six-leg 10-min SPY indicator, alerts-only, **+ the shadow ledger and a "How it works" view — see below** |
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
| `CROSS_UP` | the candle **closes at or above** the level, previous candle closed below | all four |
| `CROSS_DOWN` | the candle **closes at or below** the level, previous candle closed above | all four |

Symmetric, and the only two events that alert. `TOUCH_DOWN` — an AVWAP-only
"extended above, comes back and touches" rule — shipped 2026-08-15 and was
removed 2026-08-17; `CROSS_DOWN` is **not** the same rule and does not reinstate
it. Both directions across four levels is roughly **190 events a day**, which
stays at ~10 notifications because `alertCrossings` sends one message per sweep,
never one per ticker.

Guards: a **0.25% deadband** on the previous candle (`AVWAP_CROSS_MIN_PCT`) —
applied to the previous candle only, so clearing the level at all is the signal —
and dedup keyed on `ticker + level + direction + BAR`. Up and down dedup
independently, so a name may cross up in the morning and back down after lunch
and alert twice.

`lastCross` records **every** level crossed on that bar with its own direction —
`"avwap:CROSS_UP,sma50d:CROSS_DOWN"`, because one candle can reclaim one level
while losing another — and the tab renders one badge per level under the ticker,
plus a `×N` pill when two or more went at once. Those are the strong signals: a name reclaiming three
levels on one candle is doing something a name clipping one line is not. Until
2026-08-17 the field held a single level picked by loop order, so AVWAP crosses
silently lost to moving-average crosses and 13 of that day's 58 crossers were
under-reported. A single-level value is just the one-level case of the same
shape, so rows written by older builds still parse (`decodeLastCross` reads the
single-level, one-trailing-direction, and `TOUCH_DOWN` shapes too — nothing was
migrated).

The tab's **cross matrix** counts today's crossings per level and direction, and
every cell filters the table. Those counts come from the day's history rows, not
from `lastCross`: a name that crossed up at 07:12 and back down at 11:03 did two
things, and `lastCross` only remembers the second.

### Data flow

```
DESKTOP2  TradingView Desktop (CDP :9222)
   |      tools/tv-avwap/publish_avwap.mjs   (Task Scheduler, per candle close)
   v
POST /api/avwap-earnings   (x-timer-secret; POST-only anonymous in staticwebapp.config.json)
   |
   v
Azure Table AvwapEarnings
   current/<TICKER>          latest read per symbol — pruned to the MASTER roster
   current/__meta__          bar, publisher, failed[], pruned[]
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

**The tab equals the watchlist.** Each POST prunes `current` down to the roster
the sweep reported — `rows` ∪ `failed`. Remove a symbol from MASTER and it leaves
the tab on the next sweep. It is `∪ failed`, not `rows` alone, so a symbol the
publisher could not read this cycle holds its last values instead of flickering
off and back on. Pruning is the only destructive thing the endpoint does and it
runs unattended, so it is held back entirely when a sweep looks degraded (fewer
than `PRUNE_MIN_SWEPT` symbols, or more than 25% failed) and the reason is
recorded in `__meta__.pruneHeldBack` — a skipped delete must not be silent
either. Before this (2026-08-17) `upsert` only ever added, so a removed symbol
kept its last row forever and read as live data.

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

## SPY Conviction — alerts, the shadow ledger, and "How it works"

The tab has two views, switched in its header.

**Ledger** is the live system: a TradingView Pine indicator scores six legs
(cumulative TICK, volume pressure, SPY vs VWAP, SPY vs EMA 9, SPY/RSP relative
strength, VIX) on every closed 10-minute SPY bar, collapses them into one score
from −100 to +100, and emits the decision itself — `ARM_*`, `ARM_CANCEL`,
`BUY_*`, `HOLD_*`, `REDUCE_*`, `SELL_*`, `STAND_ASIDE`. The portal receives it
at `POST /api/spy-conviction` (alias `/api/tv-trend-webhook`, both permanent),
records every hit including rejects, mirrors the believed position, and pushes
ARM/BUY/REDUCE/SELL/CANCEL to the phone. **Nothing is traded.** Full detail in
`api/src/lib/spyConviction/README.md`.

**How it works** is the explanation of the whole system with SVG diagrams
(`src/views/spy/SpyHowItWorks.tsx`). Every rule number on it is read from the
API's `params`, so it cannot drift from the code.

### The shadow ledger (added 2026-09-05)

A standing scoreboard: after each close, `mtfrev-cron` (`spyShadowCron`,
4:20 PM ET weekdays) scores every accepted `BUY_CALL` / `BUY_PUT` of the day
against **one rule fixed in `api/src/lib/spyShadow/rule.ts`** and writes the
result to table `SpyShadowTrades` (PK = ET day, RK = `HHMM|SIDE`), which is
deliberately outside `purge-history` so the rule is judged on days it has never
seen.

| Step | Rule |
|---|---|
| Contract | SPY at-the-money strike (SPY at the signal, rounded), expiring that week's Friday |
| Entry | Let the 2-minute bar containing the alert close, then wait up to **10 minutes** for SPY's 1-minute range to touch the **9 EMA of 2-minute closes** (the EMA of the last *completed* bar). Fill at the option's 1-minute **midpoint** in that minute. No touch → `NO_TOUCH`, no trade |
| Exit | Every 1-minute bar from entry: **−9% stop first** (bar low, entry minute included), then **+20% target** (bar high, never inside the entry minute), else the **15:59 ET close**. One bar spanning both = stop |
| Sizing | A fixed **$2,000** account, all-in: `floor(2000 / (entry × 100))` contracts, not compounded. **Commission 0** (assumes Tradier Pro, $10/mo flat, SPY options commission-free — Lite's $0.35/side would have cost $227.50 on the backfill) |

Sizing and commission are applied **at read time** from the stored entry and
gross; `netUsd` is re-derived from `grossUsd − RULE.COMMISSION_RT` on every
read and never trusted from the row. Changing either constant re-prices the
whole history consistently. Per-row `tp10Hit` / `tp15Hit` and `mfePct` are kept
so a later review can compare targets without re-running anything.

Endpoints: `POST /api/spy-shadow` (timer secret **or** signed-in portal session;
`?date=` for one day, `?from=&to=` to backfill; idempotent) and `GET
/api/spy-shadow?date=` (that day's rows + the whole ledger's summary and equity
curve). The POST has a method-scoped anonymous entry in
`staticwebapp.config.json` for the cron.

Data: Alpaca **Basic (free)** — SIP 1- and 2-minute SPY bars and option
1-minute bars from the indicative feed. Everything is fetched after the close,
so the plan's 15-minute delay never matters. Keys are already in production
settings; for local scoring copy `ALPACA_API_KEY` / `ALPACA_API_SECRET` into
`api/local.settings.json` (Core Tools does **not** inherit them from the shell).

Backfill 2026-08-12 → 09-04, 39 signals, 33 filled, 6 no-touch, 42% win:
**+$1,081 (+54%)** on $2,000 with a **−$767 (−38%)** max drawdown; +$142 per
single contract. These are lower than the research scripts that found the rule
on purpose (completed-bar EMA; no target fill in the entry minute).

### How the rule was arrived at (so nobody re-runs the same dead ends)

All measured on the same 35–39 BUY alerts with real 1-minute option bars:

1. Underlying only, BUY → indicator SELL: 18% wins, breakeven.
2. Buy the next bar's open, any TP/SL 10–30%: within a few dollars of zero.
3. Stop at the alert bar's low (median 2% away): 31 of 38 stopped in minutes.
4. Midpoint entry instead of open: worse — winners are already rising in that bar.
5. Buy the bar's low (the ceiling): ~$5/contract/trade — the whole edge lived in a 2-minute fill.
6. **Wait for the 2-minute 9 EMA touch within 10 min**: win rate from the high 20s to the 50s and no longer fill-dependent. EMA 21 touched too rarely; VWAP almost never inside the window.
7. Obeying the indicator's SELL (median 10 min after entry) gave the move back every time; a mechanical target/stop/close kept it.
8. Sizing: drawdown scales one-for-one with position size (all-in −38%, one-third −8%). Day-loss stops and trade caps did not help; a "sit out after two losses" rule that looked spectacular was rejected as a fit to the sequence. A one-third-size line was built, deployed and removed the same day at the operator's request.

**Decision standing at 2026-09-05:** alerts-only stays. No broker, no executor,
no real money until the *forward* ledger (from Tue 2026-09-08) holds up for one
to two weeks. If it does, the execution venue under discussion is a Tradier
account (free Lite tier for real-time OPRA data + orders; Pro $10/mo for
commission-free SPY options), with the $2,000 all-in sizing the ledger reports.

Files: `api/src/lib/spyShadow/{rule,data}.ts`, `api/src/functions/spyShadow.ts`,
`api/tools/spy-shadow-test.mjs` (43 pure checks — run before touching the rule),
the `ShadowSection` in `src/views/SpyConvictionPage.tsx`,
`src/views/spy/SpyHowItWorks.tsx`.

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

**Validating locally behind the portal sign-in**
- The emulator's `google` provider is a custom OIDC one, so
  `/.auth/login/google` fails with `GOOGLE_CLIENT_ID not found`. Mint the
  emulator's own session cookie instead: on any local page run
  `document.cookie = "StaticWebAppsAuthCookie=" + btoa(JSON.stringify({identityProvider:"google",userId:"e2e",userDetails:"e2e@local",userRoles:["anonymous","authenticated","portal"],claims:[]})) + "; path=/"`
  then open `/#spy`. The same base64 principal works as a `Cookie:` header for
  `curl` against `/api/*` routes gated on the `portal` role.
- For a layout review of a view without a browser session, render it
  statically: `esbuild src/views/<View>.tsx --bundle --format=esm --platform=node
  --jsx=automatic --external:react --external:react-dom --external:react/jsx-runtime`
  into the repo root (so React resolves), `renderToStaticMarkup` it with
  `react-dom/server.browser`, wrap in a stub stylesheet, and screenshot with
  headless Chrome. Run Chrome **standalone** with a fresh `--user-data-dir`; it
  hangs when chained after other commands or when it shares the live profile.
- The Claude-in-Chrome extension's `screenshot` regularly times out on the
  portal tab; `zoom` on a small region, `get_page_text`, and `javascript_tool`
  keep working.

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
