# journal-sync

Feeds the portal's **Journal** tab. Runs on the dev box as a daily scheduled
task — never in Azure.

```
node sync.mjs                     full run
node sync.mjs --no-summary        trades only, skip the Claude call
node sync.mjs --dry-run           fetch and report, write nothing
node sync.mjs --self-test         exercise the summariser on fake notes, write nothing
node sync.mjs --portal http://…   aim at `swa start` instead of the live portal
```

Setup: copy `.env.example` to `journal-sync.env`, fill it in, then
`.\register-task.ps1`. `journal-sync.env` is gitignored and must stay that way.

## Why this runs locally

Two secrets would otherwise have to live in Azure, and neither needs to: the
standalone journal app's password, and a model API key. The summariser shells
out to the **Claude CLI** against the existing subscription instead. The portal
only ever holds fills, notes, and the lessons list.

## The flow

```
standalone journal app                    this job                     portal
  GET /api/trades ──────────► full history ─┐
  GET /api/snaptrade/sync ──► recent window ─┴─► FIFO match ─► POST /api/journal-trades
  (persist=false, a read)                        │
                                                 └── GET /api/journal-notes
                                                     └─► claude ─► POST /api/journal-summary
```

The other app is **read-only** here. Both calls are reads; `persist=false`
means it writes nothing.

## Why we FIFO-match down here

The upstream app can compute realized P&L, but its `persist=true` path pulls 90
days across ~10 accounts and then re-runs FIFO across the entire dataset (6k+
fills). That overruns Azure SWA's ~45s backend limit, so the platform returns a
plaintext `Backend call failure` and **nothing is written** — which is why every
closing fill since the epoch arrived with `realized_pnl: null`.

Rather than change that app, this job pulls a short window (~3s) and runs the
match locally, where there is no timeout. The matcher is a port of that app's
`api/src/fifo.ts`; it was verified against 1,812 of its own priced closes with
**zero disagreements**.

One deliberate difference: for a sell whose opening lot predates the dataset,
the upstream books just the fee (implying cost basis == exit price). This job
records `null` instead — an unknown cost basis is not a $0 trade. That only
affects fills at the very start of history (latest such case: 2026-07-15), well
before the journal epoch.

## Facts worth knowing

- **Epoch `2026-08-03`.** History starts there by decision, enforced both here
  and in the API.
- **Robinhood only.** That is where the trading happens; other brokers in the
  upstream dataset are ignored.
- **The lessons list is capped at 10, permanently.** A new lesson merges into or
  extends an existing point rather than becoming an eleventh. Enforced in the
  prompt *and* server-side, because a model told "at most 10" eventually returns
  11.
- **If this machine is off**, the tab still opens and notes still save — the
  browser talks to the portal directly. Only new fills and a refreshed summary
  wait for the next run.
