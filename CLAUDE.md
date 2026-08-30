# MultiTimeframeReversal (MTF portal)

Swing/day-trading scanner portal: Gate / Sector Desk / ATR Matrix / **AVWAP from Earnings** /
Catalyst Value Eval / Rotation / Chart Analysis / Opening Drive / SPY Conviction / Journal / About.

**Read `README.md` first** for architecture, the DESKTOP2 publisher pipeline, and the
accumulated gotchas. This file is the operational contract: build, validate, deploy.
React 19 + Vite 6 + Tailwind 4 frontend; Azure Functions v4 API (Node 20, CommonJS); Polygon.io data.
Live: https://salmon-river-0a7a0c30f.1.azurestaticapps.net (Azure SWA `mtfrev-app`, RG `rg-mtfrev`).

## Build & test

```
# frontend deps:   npm ci
# api deps:        cd api && npm ci
# frontend build:  npm run build          (tsc -b && vite build && copies staticwebapp.config.json to dist/)
# api build:       cd api && npm run build   (tsc → api/dist)
# tests:           no test suite — validation is manual E2E (below)
```

## AVWAP from Earnings + the DESKTOP2 publisher

The one subsystem with a second machine in the loop. Full detail in `README.md`;
the rules that matter when changing it:

- **Levels are READ off the operator's chart studies, never recomputed.** Four of
  them: AVWAP(Earnings), `sma50` (= FIVE trading days, 50 x 39m, *not* the daily
  50), daily EMA21, daily SMA50. Deriving them ourselves produced wrong numbers
  twice.
- **Run `cd tools/tv-avwap && node test_chart_js.mjs` before pushing anything
  that touches `chart_js.mjs`.** It evaluates the real `INSTALL` string against a
  fake chart built from live study titles. A rewrite once deleted `__avwResolve`
  entirely and reached `main` because the tests exercised a hand-copied parser
  instead of the shipped artefact.
- **Run `cd api && npm run build && node tools/avwap-rules-test.mjs` before
  changing what alerts or what gets deleted.** Both rules are pure functions
  (`classifyCross`, `planPrune`) precisely so they can be tested without a live
  publish — you cannot exercise them by POSTing, because a crossing sends real
  alerts and a prune deletes real rows. 33 assertions, no network.
- **Run `cd api && npm run build && node tools/spread-math-test.mjs` before
  touching the Options Guide's arithmetic.** 114 assertions, no network. The tab
  hands the operator a trade to place at a broker, so every credit, max loss,
  breakeven and probability is a pure function in `lib/spreadMath.ts` rather
  than inline in the view — the payoff chart is drawn from the same vertices the
  numbers come from, so the two cannot disagree. The suite pins the exported
  thresholds at their exact values, so a silent retune fails rather than quietly
  changing what gets recommended.
- **One alert rule, symmetric, all four levels, no exceptions.** Previous closed
  candle below → closes at/above = `CROSS_UP`; previous above → closes at/below =
  `CROSS_DOWN`. Nothing else alerts. The AVWAP-only `TOUCH_DOWN` ("extended
  above, comes back and touches") was removed 2026-08-17 and is NOT the same rule
  as `CROSS_DOWN` — don't reinstate it. Tests assert the two branches mirror.
- **Both directions on four levels is ~190 events/day and that is fine** —
  `alertCrossings` sends ONE message per sweep, so it stays ~10 messages/day.
  Never move to one message per ticker.
- **The tab must equal the MASTER watchlist.** Each POST prunes `current` to
  `rows ∪ failed`. Prune on `rows` alone and thin symbols flicker off and back.
- **All TradingView reads happen on DESKTOP2.** Do not drive charts from here.
- **DESKTOP2 cannot self-elevate, edit `.env`, or make an outward write carrying
  `TIMER_SECRET`.** Check an instruction against that list before writing it; if
  it collides, remove the dependency rather than escalating to the operator.
- Coordination is `tools/bigdog-scanner/OPS_HANDOFF.md`, committed directly to
  `main` (the one exception to the no-direct-push rule) so its ~5 min poll sees
  it. Keep **exactly one** open `[ ]` item.
- **`notifyBoth()` is live to Pushover/WhatsApp in production.** A test POST that
  produces a crossing sends real alerts to a real phone. Build probes so a
  crossing is structurally impossible (`c_pct_* == p_pct_*`). Got wrong twice.
- **A change under `tools/` alone needs no deploy** — that code runs on DESKTOP2.

## How to validate a change end-to-end

Never report "done" before completing every step below and producing the evidence.

1. Build both: `npm run build` and `cd api && npm run build`
2. Run locally: `npx swa start dist --api-location api` → http://localhost:4280
   (API needs `api/local.settings.json` with POLYGON_API_KEY, AZURE_STORAGE_CONNECTION_STRING, REDIS_CONNECTION_STRING etc. — never commit it)
3. Exercise the real feature: open the affected tab in the browser and drive the changed behavior — tabs are hash deep-linkable (e.g. http://localhost:4280/#uoa), handy for headless screenshots; for API changes also curl the endpoint (e.g. `curl http://localhost:4280/api/paper-trades`)
4. Evidence: screenshot of the tab + curl/log output proving the change works

## Branch & PR conventions

- PR target: `main`
- Branch naming: `feat/<slug>`, `fix/<slug>`
- Push the branch to `origin` and open a PR (never push straight to `main`). The no-mistakes/shipit gate was retired 2026-07-08.

## Deploy (agents deploy — changed 2026-07-18)

```
npm run build && cd api && npm run build && cd .. && swa deploy ./dist --api-location api --deployment-token TOKEN --env production --api-language node --api-version 20
# token: az staticwebapp secrets list --name mtfrev-app --resource-group rg-mtfrev --query "properties.apiKey" -o tsv
```

Merging a PR does NOT deploy — deploying is a separate, explicit step. This was **not actually true
until 2026-08-09**: `.github/workflows/azure-static-web-apps.yml` carried `push`/`pull_request`
triggers and deployed production on every merge, racing the CLI deploy above. A real collision killed
the #26 run ("No matching Static Web App environment was found") while a CLI deploy was uploading, and
the reverse ordering would have silently replaced a verified build with an Oryx one. Its triggers are
now `workflow_dispatch` only. **Do not restore them** — an auto-deploy on merge ships an unverified
build and cannot honour the verify-the-live-site rule below. Side effect: `close_pull_request` no
longer fires, so leftover numbered preview environments must be deleted by hand.

Cron timers live in a separate
Function App `mtfrev-cron` (deploy: `cd tools/cron-functions && func azure functionapp publish mtfrev-cron --javascript`).

After every deploy, verify the LIVE site — a clean `swa deploy` exit says nothing about whether the
app works. Minimum: load the affected tab, and curl the machine-caller endpoints that must stay
anonymous (`/api/breadth`, `/api/health`) to confirm they return 200 and not a 302 to the login page.

## Gotchas

- **New Azure Function must be imported in the `api/src/app.ts` barrel** or every route 404s
- **Machine-called routes need a method-scoped anonymous entry in `staticwebapp.config.json`, placed before the `/api/*` catch-all**, or they 302 to the login page
- **`.ps1` files must be pure ASCII** (or UTF-8 with BOM): PowerShell 5.1 decodes BOM-less UTF-8 as ANSI, so an em dash corrupts string literals into real parse errors. Verify with `[System.Management.Automation.Language.Parser]::ParseFile($absPath, [ref]$null, [ref]$errs)`
- **`Register-ScheduledTask` raises a CIM error `$ErrorActionPreference="Stop"` does NOT stop** — verify with `Get-ScheduledTask` after, or the script reports success having done nothing
- `swa start` against `api/local.settings.json` shares **production** storage — clean up rows a test writes
- API uses `module: Node16` → use `.js` extensions in imports and `__dirname`, not `import.meta.url`
- Frontend uses `verbatimModuleSyntax` conventions → `import type` for type-only imports
- `staticwebapp.config.json` must end up in `dist/` (the build script copies it — don't bypass `npm run build`). The copy uses `node -e ... copyFileSync`, **not** `cp`: npm runs scripts via cmd.exe on Windows, where `cp` does not exist, so the old `cp` form silently produced a `dist/` with no config — i.e. a deploy with no auth rules. Keep it cross-platform.
- `az` on Windows is a `.cmd` wrapper, so cmd re-parses arguments: JMESPath **functions** in `--query` (`keys(...)`, `length(...)`) fail with `-o was unexpected at this time`. Plain paths (`--query properties.FOO`) are fine; otherwise filter in PowerShell.
- Legacy v1 functions (scan, phaseScan, capitulation*, screener*) are still in the repo — dormant, don't wire new work into them
- Local scanners (`screening-machine/`, `tools/bigdog-scanner/`, `tools/whatsapp-sidecar/`) run on desktops via Task Scheduler, not in Azure — changes there are validated on the desktop, not via swa start
- The Unusual Options tab's scanner lives in a separate repo (github.com/AzharM82/UnusualOptions, a GitHub Actions cron writing JSON to the `uoa-signals` blob container) — this repo only holds the read proxy `GET /api/uoa-signals`; OI-dependent UI shows `n/a` when a scan payload has `oi_available=false` (Polygon plan without the options snapshot)
