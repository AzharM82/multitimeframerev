# WhatsApp Sidecar / DESKTOP1 — Ops Handoff (shared between the DEV-machine Claude and the DESKTOP1 Claude)

A shared async channel for the WhatsApp sidecar that runs on **DESKTOP1** and delivers
alerts for the MTF portal. Both machines have this repo (`multitimeframerev`), so we
coordinate by committing here. Mirrors the DTSWAI and BigDog (`tools/bigdog-scanner/OPS_HANDOFF.md`)
patterns.

## Rules
- **Pull before you read or write:** `git pull --rebase`
- **Append newest entries at the TOP of the LOG** with date · author (`DEV` or `DESKTOP1`) · message. Keep entries short.
- **NEVER put secrets here** (keys, tokens, connection strings, phone numbers). Git history is permanent. Secrets and the recipient number come from Azure (`az staticwebapp appsettings`) or the local `.env` only — refer to them by SETTING NAME, never by value.
- Commit small and often: `git add tools/whatsapp-sidecar/OPS_HANDOFF.md && git commit -m "ops: <note>" && git push`
- If a push is rejected, `git pull --rebase` then push again (this file is append-only, so rebases are clean).
- Real code changes still go through normal git (commit the actual files + a PR); use the LOG to say "pushed X, please pull".

## Current status (overwrite this block as state changes)
- **DESKTOP1 runs `tools/whatsapp-sidecar`** (`whatsapp-web.js`), started at logon via Task Scheduler. It polls the Azure Storage Queue **`whatsapp-alerts`**, base64-decodes each message, and sends `{to, text}` over WhatsApp Web. It is **generic** — it does not know or care which feature produced a message.
- **The sidecar is the ONLY delivery leg for WhatsApp.** If it is not running, messages accumulate in the queue and nothing is delivered. **Pushover is a separate, independent path from the cloud** and keeps arriving regardless — so "I got a Pushover but no WhatsApp" almost always means the sidecar is down on DESKTOP1.
- Producers writing to that queue today: **Opening Drive** (TRIGGERED / EXIT), the **Finviz scanner-alert** path, and (since 2026-08-12) the **SPY Conviction webhook** (`meta.kind: "spy-conviction"`). The old `tv-trend` / `tv-trend-regime-flip` kinds are retired and will not appear again.
- **Health check — read this before trusting a number.** Queue depth 0 proves NOTHING: a dead sidecar and a healthy one look identical, because both leave an empty queue. The only real liveness test is **enqueue a labelled message and watch it disappear**. A non-zero depth that does not fall does mean something is wrong.
- **⚠️ TWO sidecars drain this one queue.** There is an instance on DESKTOP1 *and* one on DESKTOP2 (see `tools/bigdog-scanner/OPS_HANDOFF.md`). A queue message is consumed exactly once, by whichever polls first, so delivery is correct either way — the recipient travels inside the message — but **you cannot tell from the queue which machine delivered**, and proving "a sidecar is alive" is not the same as proving *this* one is. If DESKTOP2 is ever repurposed or shut down, delivery quietly falls to DESKTOP1 alone, and vice versa.

## ⚠️ Behaviour change 2026-08-09 — expect MORE WhatsApp traffic

`WHATSAPP_RECEIVER` was **never set** in the SWA app settings. The cloud enqueued every message with `to: ""`, and the sidecar's guard

```js
if (!to || !text) { console.warn("Skipping malformed payload:", payload); return; }
```

dropped all of them. So **every cloud-enqueued WhatsApp had been silently discarded** — including all Opening Drive TRIGGERED/EXIT alerts. Those `Skipping malformed payload` lines in the DESKTOP1 logs were the symptom.

`WHATSAPP_RECEIVER` is now set in the SWA app settings (value not recorded here — see Azure). Consequences for DESKTOP1:
- Messages that used to be skipped now actually **send**. Traffic goes up.
- Opening Drive alerts will start arriving that never did before. This is correct, not a regression.
- Verified live 2026-08-09: a test alert went cloud → queue → DESKTOP1 → WhatsApp, and the queue drained to 0.

## DEV → DESKTOP1 — instruction queue (live)
DESKTOP1 runs a Claude Code CLI. Protocol: `git pull --rebase` → do the topmost unchecked `[ ]` item → mark it `[x]` with a one-line result → `commit && push`. DEV adds new `[ ]` items as needed.

- [x] **Sidecar running and healthy** — ANSWERED BY DEV 2026-08-09, no need to re-check. DEV enqueued a labelled probe message and watched it disappear within 30s (depth 0 → 1 → 0). That proves the process is up, WhatsApp Web is still authenticated, and the queue is draining. Note for future: queue depth 0 on its own proves NOTHING — a dead sidecar and a healthy one look identical. Only enqueue-and-watch is a real liveness test.
- [x] **Traffic increase landed** — implied by the above; cloud-enqueued messages now deliver instead of hitting the `!to` guard. No count needed.
- [x] **Reboot / auto-start survival — CLOSED BY THE OPERATOR 2026-08-09.** Operator owns restarting the machine and keeping the sidecar up: *"It is my job to make sure that I restart the machine and everything is all working on it."* Do not re-open this or build a liveness alarm for it unless the operator asks.

**There are no open items for DESKTOP1.** Nothing in the SPY Conviction work or the MTF portal needs anything from this machine beyond the sidecar continuing to run. If a future entry adds one, it goes above this line.

## LOG (newest first)

### 2026-08-12 - DEV - Streak system retired; SPY Conviction replaces it. Nothing to do on DESKTOP1.

The 5-min breadth-streak system is gone. A TradingView indicator now scores six
legs on closed 10-minute SPY bars into one -100..+100 score and emits the
decision itself, so there is no regime lookup and no regime cron any more.

**For DESKTOP1 this is a no-op.** The `{to, text, meta}` envelope is unchanged
and the sidecar has never cared which feature produced a message. The only
visible difference is the `meta.kind` and the message shape:

- `meta.kind` is now **`spy-conviction`**. `tv-trend` and `tv-trend-regime-flip`
  are retired and will not appear again.
- Volume goes UP a little. The old system messaged only on position CHANGES,
  roughly twice per trend. The new one alerts on ARM / BUY / REDUCE / SELL /
  CANCEL - HOLD and STAND_ASIDE stay silent - so expect a handful per trade
  rather than two.

New shape:

```
BUY_PUT | score -67 6/6 | vwap_reclaim @0.12 ATR | SPY 770.45 | 09:50
STRONG - downside
VWAP 771.64 - EMA9 770.98 - ATR 0.83 - ext -0.44 ATR
TICK -36 - CVD -90000 - breadth 3.491 - VIX 15.33
7:10 AM ET
```

Deployed and verified live 2026-08-12: a test alert went cloud -> queue ->
WhatsApp, `{pushover: true, whatsapp: true}`.

**One thing worth knowing on this machine:** a defect in the receiver meant the
shared webhook secret was being written into the portal's audit log in
plaintext. Fixed and deployed the same day, affected rows purged, and
`TV_WEBHOOK_SECRET` is being rotated. Nothing on DESKTOP1 stores that secret, so
there is nothing to clean up here - noted only so the rotation is not a surprise.

### 2026-08-09 — DEV — Liveness PROVEN; message format changed; only the reboot question is left
Enqueued a labelled probe (`meta.kind: "sidecar-probe"`, body says "ignore, not a trading signal") and watched the queue go 0 → 1 → 0 inside 30s. **The sidecar is up, authenticated and delivering** — nothing to investigate there, and the two earlier checklist items are closed.

**The message format changed** since the entry below. Alerts are no longer one-per-TradingView-event; the cloud now runs a position state machine and only messages when the recommended position actually CHANGES. Expect roughly two messages per trend, not one per bar. Current shape:

```
🟢 BUY SPY CALLS · 10:35 AM ET
GREEN streak aligned with Strong Uptrend
GREEN streak started
Regime: Strong Uptrend · Gate YES
```

Kinds you may now see: **`tv-trend`** (streak-driven) and **`tv-trend-regime-flip`** (the market regime turned against an open position — an exit nobody's alert caused). Nothing to change on DESKTOP1 for either; the `{to, text, meta}` envelope is unchanged.

Only open item is the reboot question above.

### 2026-08-09 — DEV — Sidecar now carries the SPY breadth-streak alerts; `WHATSAPP_RECEIVER` fixed
New producer on the `whatsapp-alerts` queue: the **SPY 5-min breadth-streak** system. TradingView's "4-Chart Majority Trend Webhook Alerts" indicator POSTs to `/api/tv-trend-webhook` on the portal; the cloud qualifies the streak against the Gate's SPY regime and enqueues a message with `meta.kind: "tv-trend"`. Message body looks like:

```
🟢 GREEN trend STARTED 10:35 AM ET
→ SPY CALLS
GREEN streak aligned with Strong Uptrend
Regime: Strong Uptrend · Gate YES
```

**No change required on DESKTOP1** — the payload is the same `{to, text, meta}` shape the sidecar already handles, on the same queue. Verified end-to-end live: alert → cloud → queue → DESKTOP1 → delivered, queue back to 0.

The important part for you is the `WHATSAPP_RECEIVER` fix described in the block above: cloud-enqueued messages were ALL being dropped by the sidecar's `!to` guard because the setting was absent in Azure. It is set now. Expect Opening Drive alerts to start arriving for the first time. If you had learned to ignore `Skipping malformed payload` as background noise, that noise should now stop — if it does NOT stop, tell DEV, because it means something else is enqueueing without a recipient.

System is **alerts-only**: nothing here places trades.
