# Score Backtest

Does the Trade Desk 7-factor score actually predict returns? This tool answers
that with data instead of intuition. It reconstructs the **exact** scoring
engine from `index.html` (proven identical to the JS — see parity test) over
Bybit history, labels every snapshot with its forward return, and measures the
edge of each factor and of the composite score.

## Why this exists

The live scanner (`index.html`, `trd*` functions) ranks coins with hand-tuned
weights and thresholds (`TRD_W = {mom:0.15, trend:0.17, …}`, `50 + chg*7`, …).
None of it has been validated: we don't know if a high score means a higher
win-rate, which factors carry edge, or whether any of it survives out-of-sample.
This tool closes that gap.

## Files

| File | Role |
|---|---|
| `factors.py` | Literal Python port of the JS scoring engine (`trd*`). |
| `js_reference.js` | Verbatim copy of the JS functions, for the parity check. |
| `test_parity.py` | Proves `factors.py` == the live JS over thousands of random cases. |
| `bybit_data.py` | Fetch real Bybit history **or** fabricate a synthetic panel. |
| `backtest.py` | Reconstruct factors as-of each bar, label, and measure edge. |

## Setup

```bash
pip install -r requirements.txt   # numpy, scipy, requests  (Node needed only for parity)
```

## 1. Prove the port matches the live app

```bash
python3 test_parity.py
# -> PARITY OK — Python port matches the live JS exactly.  (88,000 comparisons)
```

Run this whenever you change the scoring logic in `index.html`: update
`js_reference.js` to match, re-run, and keep it green.

## 2. Get data

**Offline demo (works anywhere):**
```bash
python3 bybit_data.py --source synthetic --symbols 30 --days 45 --out dataset.json
```

**Real Bybit data (run where `api.bybit.com` is reachable — it is blocked from
the Claude Code web sandbox by egress policy):**
```bash
python3 bybit_data.py --source bybit --symbols 40 --days 45 --out dataset.json
```
This mirrors the scanner's universe (liquid USDT perps, no leveraged tokens) and
pulls hourly klines + funding history + open-interest history, cached to JSON.

## 3. Backtest

```bash
python3 backtest.py --dataset dataset.json --horizon 12 --topk 5 --out report
# writes report.md, report.html, report.json  and prints the report
```

`--horizon` is the forward-return window in hours (the payoff the score is
implicitly predicting); `--topk` sizes the long/short portfolio in section 4.

## What it measures

1. **Per-factor Information Coefficient** — Spearman corr between each factor and
   the forward return. Near-zero IC = that factor is dead weight.
2. **Composite-score calibration** — win-rate and mean forward return by score
   decile. A working score is monotonic; the demo shows 42% → 56% win-rate.
3. **Walk-forward stability** — out-of-sample IC per fold, with purge + embargo
   (≥ 2× horizon) so no label leaks across the train/test boundary.
4. **Top-K long/short portfolio** — Sharpe, drawdown, hit-rate, plus a
   **Deflated Sharpe Ratio** that discounts the ~20 hand-tuned constants in the
   score (multiple-testing correction; p < 0.95 = not distinguishable from luck).

Methodology follows the `walk-forward-validation` skill (leak-free splits,
deflated Sharpe). It is intentionally dependency-light (no vectorbt/numba) so it
runs on the user's machine or a server unchanged; a full portfolio simulation
with `vectorbt` is the natural follow-on once the factors prove out.

## Reading the result

- **All ICs ~ 0** → the score decorates noise; re-weighting won't help until
  factors with real IC exist (`feature-engineering`, `custom-indicators`).
- **Deciles non-monotonic** → the UI number is miscalibrated; it doesn't mean
  what a user assumes when they trade off it.
- **OOS IC flips sign across folds** → no stable edge; any single backtest number
  is luck.
- **Which factors survive** tells you what to keep, drop, or re-weight — that is
  the input to a data-driven re-tune (step #2 of the improvement plan).

> Synthetic-dataset numbers validate the *pipeline*, not the strategy. Only a
> Bybit run is a verdict on the real score.
