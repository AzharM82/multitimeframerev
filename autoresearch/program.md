# autoresearch — MTF Reversal Day-Trade research loop

You are running a weekly research round on the MTF Reversal day-trade
pipeline. Your job: find **one** code change that improves the metric on
the held-out validation split, write a concise report, open a PR.

This skill lives in `autoresearch/` inside the `multitimeframerev` repo.
All `uv run …` commands run from `autoresearch/`. `git` commands run from
the repo root (the research branch covers the whole repo). The sibling
clone of `tos-reversal-scanner` lives at `../tos-reversal-scanner/`
relative to the repo root.

## Setup (run once at the start of the round)

1. Tag the round (from repo root):
   ```
   TAG=autoresearch/$(date +%G-W%V)   # e.g. autoresearch/2026-W20
   git checkout -b "$TAG"
   ```
2. Refresh the data cache:
   ```
   cd autoresearch && uv run prepare.py
   ```
   Expect `autoresearch/data/alerts.parquet`, `train.parquet`,
   `val.parquet`, and `data/bars/<TICKER>/<YYYY-MM-DD>.parquet`.
3. Establish the baseline:
   ```
   cd autoresearch && uv run evaluate.py > run.log 2>&1
   grep "^metric:\|^split_used:\|^expected_pnl:" run.log
   ```
   Record the baseline `metric:` value. Initialize `autoresearch/results.tsv`
   if it's missing:
   ```
   commit	metric	val_n	val_pnl	train_pnl	status	description
   ```
4. Read `autoresearch/strategy.py`, `autoresearch/evaluate.py`, and the
   sibling clone `../tos-reversal-scanner/scanner/finviz_scanner.py` so
   you know the editable surface.

## The loop (keep iterating until the wall-clock budget runs out)

1. Pick an idea — read `autoresearch/results.tsv` for past trials, look at
   val-split trade distribution (which tickers/times/exits lose money?),
   and pick **one** concept. Examples that have historically been fruitful
   in this kind of system:
   - Time-of-day filter on `should_take` (e.g. drop signals before 06:35 PT
     when the open is too choppy)
   - Ticker-quality filter (volume, ATR, prior-day close range)
   - Asymmetric TP/SL (e.g. 2.5% target with 1.2% SL)
   - Position sizing scaled to conviction (e.g. lower bars_ago = larger size)
   - OCR sanity widening / narrowing in `../tos-reversal-scanner/scanner/`
2. Edit ONE concept at a time. Multi-knob changes are noise.
3. Run:
   ```
   cd autoresearch && uv run evaluate.py > run.log 2>&1
   ```
4. Grep the result:
   ```
   grep "^metric:\|^expected_pnl:\|^win_rate:\|^n_trades:" run.log
   ```
   If grep returns nothing, `tail -n 50 run.log` to find the traceback,
   then fix or revert. Don't try the same thing twice.
5. **Keep / discard decision rule**:
   - `metric` improved on val AND `val n_trades >= 5`: commit, advance
     HEAD, append a row to `autoresearch/results.tsv` describing the
     *hypothesis* (not the diff — the diff is in the commit).
   - Otherwise: `git reset --hard HEAD~1` (or `git checkout -- .` if
     uncommitted), append `discard` row to `results.tsv` with the metric.
   - **Simplicity tiebreaker**: a 1% gain that requires 50 ugly lines —
     skip. An equal-metric simplification — keep.
6. Track wall-clock. With 10 minutes of budget remaining, **stop the
   loop** and move to the output phase. Until then, keep iterating —
   don't ask for permission, don't summarize early.

## Output (with ~10 min of budget remaining)

1. Find the single best `keep` commit on the round branch:
   ```
   git log autoresearch/$TAG --oneline
   ```
   Identify the commit with the best val-split metric (smallest = best).
2. Write `autoresearch/reports/<TAG>.md`. Match the format in
   `autoresearch/reports/EXAMPLE.md`:
   - TL;DR (2-3 sentences)
   - Hypothesis (what you were testing and why)
   - The diff (copy-pasted from `git show`)
   - Metrics table: baseline vs new on train + val
   - Side effects (exit-reason distribution shifts, n_trades changes,
     ticker-level winners/losers)
   - Trials-this-round table from `results.tsv`
   - One paragraph "what to try next round"
3. Commit the report. Push the round branch:
   ```
   git push -u origin "autoresearch/$TAG"
   ```
4. Open a PR on `multitimeframerev`:
   ```
   gh pr create --title "autoresearch $TAG: <one-sentence summary>" \
     --body "$(cat autoresearch/reports/$TAG.md)" --base main
   ```
5. If the change touches `../tos-reversal-scanner/`, also open a PR on
   that repo from a parallel branch, linking back to this round's report.

## Hard rules

- **DO edit:** `autoresearch/strategy.py`, files under
  `../tos-reversal-scanner/scanner/`.
- **DO NOT edit:** `autoresearch/prepare.py`, `autoresearch/evaluate.py`,
  `autoresearch/program.md` (this file), or anything under
  `api/`, `src/`, `tools/` in the multitimeframerev repo. The evaluator
  and data layer are frozen so trial results are comparable across weeks.
- **DO NOT add new dependencies** without justifying them in the report.
- **DO NOT merge** any PR — always leave PRs open for human review.
- **DO NOT push directly to `main`** on either repo. Always work on the
  `autoresearch/<tag>` branch and PR.
- When in doubt: revert and pick another idea. Time is fixed; ideas are
  cheap.
