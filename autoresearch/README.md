# mtf-autoresearch

A chat-driven research loop that looks for one concrete improvement to
the **MTF Reversal Day-Trade pipeline**. The harness lives in this
directory; rounds are driven by the user from their local Claude Code
session — no cron, no GitHub Actions, no separate API spend.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).
Same invariants, different domain:

| autoresearch | here |
|---|---|
| mutable `train.py` | mutable `strategy.py` (+ siblings in tos-reversal-scanner) |
| frozen `prepare.py` + `evaluate_bpb` | frozen `prepare.py` + `evaluate.py` |
| scalar metric `val_bpb` | scalar metric `-expected_pnl_per_signal` |
| 5-min trial budget | ~30-60s per backtest |
| git branches as memory | `autoresearch/<iso-week>` branches |
| `results.tsv` ledger | same — `commit, metric, win_rate, n_trades, status, description` |

## How a round works

1. `prepare.py` refreshes the local cache:
   - All alerts from Azure Table `AlertLog`
   - 1-min Polygon OHLC for each alert's session day (cached on disk so trials are fast)
   - Train / val chronological split (80 / 20) into `data/train.parquet` and `data/val.parquet`
2. Open Claude Code in this repo and follow `program.md` — read `results.tsv`, pick an idea, edit `strategy.py`
3. `evaluate.py` replays all cached alerts through the strategy and prints a structured
   summary block. Single metric is the agent's signal.
4. Keep / revert. Repeat until you decide to stop.
5. Best change → markdown report → PR against `multitimeframerev` (and optionally
   `tos-reversal-scanner`).

## Running

```bash
cd autoresearch
uv run prepare.py
uv run evaluate.py                 # baseline
claude code                        # follow program.md
```

Past round output lives in `reports/<iso-week>.md` and on the corresponding
`autoresearch/<iso-week>` branch.

## Local env

Put in a `.env` at the autoresearch/ root (not committed):

```
AZURE_STORAGE_CONNECTION_STRING=...
POLYGON_API_KEY=...
```

Pulled from your live SWA's app settings via `az staticwebapp appsettings list
--name mtfrev-app --resource-group rg-mtfrev`.
