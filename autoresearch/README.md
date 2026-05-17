# mtf-autoresearch

A Claude-Code-driven research loop that looks for one concrete improvement
to the **MTF Reversal Day-Trade pipeline** each week.

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
   - All alerts from Azure Table `AlertLog` (~410 rows today, growing weekly)
   - 1-min Polygon OHLC for each alert's session day (cached on disk so trials are fast)
   - Train / val chronological split (80 / 20) into `data/train.parquet` and `data/val.parquet`
2. Claude Code reads `program.md`, inspects `results.tsv`, picks an idea, edits `strategy.py`
3. `evaluate.py` replays all cached alerts through the strategy and prints a structured
   summary block. Single metric is the agent's signal.
4. Keep / revert. Repeat until time budget exhausted.
5. Best change → markdown report → PR against `tos-reversal-scanner`.

## Running

- **Locally**: `uv run prepare.py && uv run evaluate.py` — establishes the baseline.
  Then `claude code` and follow `program.md`.
- **In CI**: triggered every Saturday 18:00 PT by `.github/workflows/weekly-research.yml`.

## Required secrets / env

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | LLM calls for Claude Code |
| `AZURE_STORAGE_CONNECTION_STRING` | Read `AlertLog` table |
| `POLYGON_API_KEY` | 1-min aggs + snapshot |
| `GH_PAT_TOS_REPO` | Push PRs against `tos-reversal-scanner` (the master-branch repo) |
