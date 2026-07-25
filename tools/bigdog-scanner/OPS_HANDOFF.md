# BigDog / DESKTOP2 — Ops Handoff (shared between the DEV-machine Claude and the DESKTOP2 Claude)

A shared async channel for the BigDog scanner that runs on DESKTOP2. Both
machines have this repo (`multitimeframerev`), so we coordinate by committing here.
Mirrors the DTSWAI `OPS_HANDOFF.md` pattern used with DESKTOP1.

## Rules
- **Pull before you read or write:** `git pull --rebase`
- **Append newest entries at the TOP of the LOG** with date · author (`DEV` or `DESKTOP2`) · message. Keep entries short.
- **NEVER put secrets here** (keys, tokens, connection strings, phone numbers). Git history is permanent. Secrets come from Azure (`az`) or the local `.env` only.
- Commit small and often: `git add tools/bigdog-scanner/OPS_HANDOFF.md && git commit -m "ops: <note>" && git push`
- If a push is rejected, `git pull --rebase` then push again (this file is append-only, so rebases are clean).
- Real code changes still go through normal git (commit the actual files + a PR); use the LOG to say "pushed X, please pull".

## Current status (overwrite this block as state changes)
- **BigDog TODAY:** intraday 5-min scanner on DESKTOP2 → OCRs a consolidated TOS study (`BigDog_OCR.tos`) on a 5-min chart → **signed composite score −6..+6** → `POST /api/bigdog-alert` (x-timer-secret) → Azure table `BigDogAlerts` → **BIGD-Intraday** tab. Universes = two **Finviz** screeners (bull/bear). WhatsApp primary via the shared `whatsapp-alerts` queue + `tools/whatsapp-sidecar` (also on DESKTOP2).
- **CHANGE IN FLIGHT (operator, 2026-07-24): pivot BigDog stocks → OPTIONS.**
  - **Drop Finviz** entirely; universe = a **local watchlist** on DESKTOP2.
  - **No score.** Alerts carry **additional data points** instead of the signed −6..+6.
  - DESKTOP2 keeps sending the "same" alert flow, but for options with the new fields.
  - Spans 3 layers that must agree on the new payload: **(1)** DESKTOP2 scanner (`tools/bigdog-scanner/scanner/`), **(2)** `/api/bigdog-alert` + `BigDogAlerts` table (MTF portal API), **(3)** BIGD-Intraday tab UI (`src/views/BigdIntradayPage.tsx`).

## DEV → DESKTOP2 — instruction queue (live)
DESKTOP2 runs a Claude Code CLI. Protocol: `git pull --rebase` → do the topmost unchecked `[ ]` item → mark it `[x]` with a one-line result → `commit && push`. DEV adds new `[ ]` items as needed.

- [ ] **DESKTOP2: drop your options-migration spec here (in a new LOG entry below), then push.** DEV needs, specifically:
  1. **Local watchlist** — where it lives (file path/format) and how the scanner reads it (replacing the Finviz bull/bear fetch).
  2. **The new alert payload** — the exact field list you'll emit per options alert (the "additional data points"), with types + example values, and confirmation the **score is gone**. This is the contract all 3 layers key off.
  3. **Trigger/gate** — with no score, what fires an alert now? (a level cross? an option-chain condition? a chart signal?) and any dedup key.
  4. **TOS study / OCR** — are you reusing `BigDog_OCR.tos` (modified) or a new study? which chips does the scanner OCR for options?
  5. Anything already changed on DESKTOP2 (so DEV doesn't duplicate it).
- [ ] **DEV:** once the payload contract is posted, draft the 3-layer plan (scanner ↔ API/table ↔ BIGD-Intraday UI) in chat for operator approval, then implement the cloud + UI side.

## LOG (newest first)

### 2026-07-24 — DEV — created this channel; awaiting DESKTOP2's options spec
Set up this handoff file (there was none for DESKTOP2 — the DTSWAI OPS_HANDOFF is DESKTOP1-only). Operator says DESKTOP2's Claude already wrote options-migration instructions but they were **not pushed to any repo I can see** (searched `multitimeframerev` + `screening-machine` + `DTSWAI`, all branches — nothing newer than 2026-07-20, no instruction file). **DESKTOP2: pull this file, paste your spec as a new LOG entry above (the 5 points in the instruction queue), and push** so DEV can pick it up. Confirmed the DESKTOP2 scanner repo/dir = `multitimeframerev/tools/bigdog-scanner/`.
