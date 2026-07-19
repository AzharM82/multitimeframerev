# MultiTimeframeReversal (MTF portal)

Swing/day-trading scanner portal: AVWAP / Swing List / ATR Matrix / Unusual Options / CVE / BIGD-Intraday / About tabs.
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

Merging a PR does NOT deploy — deploying is a separate, explicit step. Cron timers live in a separate
Function App `mtfrev-cron` (deploy: `cd tools/cron-functions && func azure functionapp publish mtfrev-cron --javascript`).

After every deploy, verify the LIVE site — a clean `swa deploy` exit says nothing about whether the
app works. Minimum: load the affected tab, and curl the machine-caller endpoints that must stay
anonymous (`/api/breadth`, `/api/health`) to confirm they return 200 and not a 302 to the login page.

## Gotchas

- API uses `module: Node16` → use `.js` extensions in imports and `__dirname`, not `import.meta.url`
- Frontend uses `verbatimModuleSyntax` conventions → `import type` for type-only imports
- `staticwebapp.config.json` must end up in `dist/` (the build script copies it — don't bypass `npm run build`). The copy uses `node -e ... copyFileSync`, **not** `cp`: npm runs scripts via cmd.exe on Windows, where `cp` does not exist, so the old `cp` form silently produced a `dist/` with no config — i.e. a deploy with no auth rules. Keep it cross-platform.
- `az` on Windows is a `.cmd` wrapper, so cmd re-parses arguments: JMESPath **functions** in `--query` (`keys(...)`, `length(...)`) fail with `-o was unexpected at this time`. Plain paths (`--query properties.FOO`) are fine; otherwise filter in PowerShell.
- Legacy v1 functions (scan, phaseScan, capitulation*, screener*) are still in the repo — dormant, don't wire new work into them
- Local scanners (`screening-machine/`, `tools/bigdog-scanner/`, `tools/whatsapp-sidecar/`) run on desktops via Task Scheduler, not in Azure — changes there are validated on the desktop, not via swa start
- The Unusual Options tab's scanner lives in a separate repo (github.com/AzharM82/UnusualOptions, a GitHub Actions cron writing JSON to the `uoa-signals` blob container) — this repo only holds the read proxy `GET /api/uoa-signals`; OI-dependent UI shows `n/a` when a scan payload has `oi_available=false` (Polygon plan without the options snapshot)
