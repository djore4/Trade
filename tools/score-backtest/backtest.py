"""Backtest the Trade Desk 7-factor score — does it actually predict returns?

Pipeline (leak-free, per walk-forward-validation methodology):

1. Reconstruct, at every hourly bar t and for every symbol, the exact `Cand`
   the live scanner would have built using ONLY data up to t (no lookahead):
   24h change, funding in force, 24h turnover, EMA9/21, RSI14, 48-bar breakout,
   volume spike, 24h OI change. Score long and short with factors.py.
2. Label each snapshot with the forward return over horizon H hours.
3. Measure edge:
   * per-factor Information Coefficient (Spearman rank corr with fwd return),
   * composite-score decile calibration (win-rate & mean fwd payoff per decile),
   * a simple top-K long/short portfolio and its Sharpe / drawdown,
   * walk-forward stability with purge + embargo (>= 2x H),
   * Deflated Sharpe Ratio to discount multiple-testing / short samples.

Outputs a Markdown + HTML report. Numbers on a synthetic dataset are a
mechanism demo, not a verdict on the real strategy — run against a Bybit
dataset for that.

Usage:
    python3 bybit_data.py --source synthetic --out dataset.json     # or bybit
    python3 backtest.py --dataset dataset.json --horizon 12 --topk 5
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.stats import norm, rankdata

import factors as F

HOUR_MS = 3_600_000
WARMUP = 48          # bars of history needed before the first decision
LOOKBACK = 120       # EMA/RSI window the live scanner fetches


# ── Factor reconstruction (as of bar t, past-only) ───────────────────────────

def funding_at(funding, bar_time_ms) -> float:
    """Latest funding rate (%) with timestamp <= bar_time. 0 if none yet."""
    lo, hi, ans = 0, len(funding) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if funding[mid][0] <= bar_time_ms:
            ans = funding[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return (ans or 0.0) * 100.0


def build_candidate(sd: dict, t: int) -> F.Cand | None:
    close = sd["close"]
    if t < WARMUP or t - 24 < 0:
        return None
    price = close[t]
    if not price or price <= 0:
        return None
    win = close[max(0, t - LOOKBACK + 1): t + 1]          # last <=120 closes incl t
    c = F.Cand(symbol=sd.get("_sym", ""), coin=sd.get("_sym", "")[:-4], price=price)
    prev24 = close[t - 24]
    c.chg = (price - prev24) / prev24 * 100 if prev24 else 0.0
    c.fr = funding_at(sd["funding"], sd["start_ms"] + t * sd["step_ms"])
    c.turnover = float(np.sum(sd["turnover"][t - 23: t + 1]))     # 24h quote turnover
    c.ef = F.trd_ema(win, 9)
    c.es = F.trd_ema(win, 21)
    c.rsi = F.trd_rsi(win, 14)
    hs = sd["high"][t - 48: t]                            # 48 bars before t (exclusive)
    ls = sd["low"][t - 48: t]
    if hs:
        c.hi = max(hs)
        c.lo = min(ls)
    vols = sd.get("volume") or sd["turnover"]
    vwin = vols[t - 24: t]                                # 24 bars before t
    if len(vwin) >= 6:
        avg = float(np.mean(vwin))
        c.vol_spike = (vols[t - 1] / avg) if avg > 0 else 1.0
    oi = sd.get("oi")
    if oi and oi[t] is not None and oi[t - 24] is not None and oi[t - 24]:
        c.oi_chg = (oi[t] - oi[t - 24]) / oi[t - 24] * 100
    return c


# ── Snapshot panel ───────────────────────────────────────────────────────────

@dataclass
class Snap:
    t: int
    sym: str
    long_final: int
    short_final: int
    factors_long: dict
    fwd: float          # forward return over horizon (fraction), long perspective


def build_panel(data: dict, horizon: int) -> list[Snap]:
    snaps: list[Snap] = []
    for sym, sd in data["symbols"].items():
        sd = dict(sd)
        sd["_sym"] = sym
        close = sd["close"]
        n = len(close)
        for t in range(WARMUP, n - horizon):
            c = build_candidate(sd, t)
            if c is None:
                continue
            fwd = (close[t + horizon] - close[t]) / close[t]
            fl = F.factor_vector(c, "long")
            snaps.append(Snap(
                t=t, sym=sym,
                long_final=int(fl["final"]),
                short_final=int(F.trd_score(c, "short").final),
                factors_long=fl,
                fwd=fwd,
            ))
    return snaps


# ── Metrics ──────────────────────────────────────────────────────────────────

def spearman_ic(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) < 10:
        return float("nan")
    xr, yr = rankdata(x), rankdata(y)
    if np.std(xr) == 0 or np.std(yr) == 0:
        return float("nan")
    return float(np.corrcoef(xr, yr)[0, 1])


def per_factor_ic(snaps: list[Snap]) -> dict:
    fwd = np.array([s.fwd for s in snaps])
    out = {}
    for name in F.FACTOR_NAMES + ["final"]:
        x = np.array([s.factors_long[name] for s in snaps])
        out[name] = spearman_ic(x, fwd)
    return out


def decile_calibration(snaps: list[Snap]) -> list[dict]:
    """Long-score deciles vs forward long payoff — is a high score better?"""
    xs = np.array([s.long_final for s in snaps], dtype=float)
    fwd = np.array([s.fwd for s in snaps])
    order = np.argsort(xs)
    rows = []
    nb = 10
    for b in range(nb):
        idx = order[b * len(order) // nb:(b + 1) * len(order) // nb]
        if len(idx) == 0:
            continue
        r = fwd[idx]
        rows.append({
            "bucket": b + 1,
            "score_lo": float(xs[idx].min()),
            "score_hi": float(xs[idx].max()),
            "n": int(len(idx)),
            "win_rate": float(np.mean(r > 0)),
            "mean_fwd_pct": float(np.mean(r) * 100),
            "median_fwd_pct": float(np.median(r) * 100),
        })
    return rows


def portfolio_curve(snaps: list[Snap], horizon: int, topk: int):
    """Non-overlapping rebalance every `horizon` h: long top-K, short bottom.

    Return per period = mean(long fwd) - mean(short fwd via short_final ranking).
    Short payoff uses -fwd of the highest short_final names.
    """
    by_t: dict[int, list[Snap]] = {}
    for s in snaps:
        by_t.setdefault(s.t, []).append(s)
    times = sorted(by_t)
    period_returns = []
    last_used = -10**9
    for t in times:
        if t - last_used < horizon:     # non-overlapping holding periods
            continue
        row = by_t[t]
        if len(row) < 2 * topk:
            continue
        longs = sorted(row, key=lambda s: -s.long_final)[:topk]
        shorts = sorted(row, key=lambda s: -s.short_final)[:topk]
        long_ret = np.mean([s.fwd for s in longs])
        short_ret = np.mean([-s.fwd for s in shorts])
        period_returns.append(0.5 * (long_ret + short_ret))
        last_used = t
    period_returns = np.array(period_returns)
    if len(period_returns) < 3:
        return period_returns, {"periods": int(len(period_returns))}
    periods_per_year = (365 * 24) / horizon
    mean = float(np.mean(period_returns))
    sd = float(np.std(period_returns, ddof=1))
    sharpe = (mean / sd * math.sqrt(periods_per_year)) if sd > 0 else float("nan")
    equity = np.cumprod(1 + period_returns)
    peak = np.maximum.accumulate(equity)
    max_dd = float(np.max((peak - equity) / peak)) if len(equity) else float("nan")
    stats = {
        "periods": int(len(period_returns)),
        "mean_period_pct": mean * 100,
        "sharpe_annual": sharpe,
        "hit_rate": float(np.mean(period_returns > 0)),
        "total_return_pct": float((equity[-1] - 1) * 100),
        "max_drawdown_pct": max_dd * 100,
        "skew": float(_skew(period_returns)),
        "excess_kurtosis": float(_kurt(period_returns)),
    }
    return period_returns, stats


def _skew(x):
    x = x - np.mean(x)
    s = np.std(x)
    return np.mean(x**3) / s**3 if s > 0 else 0.0


def _kurt(x):
    x = x - np.mean(x)
    s = np.std(x)
    return (np.mean(x**4) / s**4 - 3) if s > 0 else 0.0


def deflated_sharpe(sr_annual, n_periods, num_trials, skew, kurt):
    """DSR probability that true SR>0 (walk-forward-validation skill)."""
    if not np.isfinite(sr_annual) or n_periods < 3:
        return float("nan")
    sr = sr_annual                     # keep annualized; scale-consistent
    sr_std = math.sqrt(max(1e-12,
        (1 - skew * sr + (kurt + 3 - 1) / 4 * sr**2) / (n_periods - 1)))
    em = 0.5772156649
    z = norm.ppf(1 - 1 / max(2, num_trials))
    z2 = norm.ppf(1 - 1 / (max(2, num_trials) * math.e))
    expected_max = z * (1 - em) + em * z2
    return float(norm.cdf((sr - expected_max) / sr_std))


def walk_forward_ic(snaps: list[Snap], horizon: int, folds: int = 6) -> dict:
    """OOS composite-score IC per fold, with an embargo of 2x horizon."""
    ts = sorted({s.t for s in snaps})
    if len(ts) < folds * 3:
        return {"folds": 0}
    embargo = 2 * horizon
    bounds = np.linspace(ts[0], ts[-1] + 1, folds + 1).astype(int)
    ics = []
    for i in range(folds):
        lo, hi = bounds[i] + (embargo if i > 0 else 0), bounds[i + 1]
        seg = [s for s in snaps if lo <= s.t < hi]
        if len(seg) < 20:
            continue
        x = np.array([s.long_final for s in seg], dtype=float)
        y = np.array([s.fwd for s in seg])
        ics.append(spearman_ic(x, y))
    ics = [v for v in ics if np.isfinite(v)]
    if not ics:
        return {"folds": 0}
    return {
        "folds": len(ics),
        "mean_ic": float(np.mean(ics)),
        "std_ic": float(np.std(ics, ddof=1)) if len(ics) > 1 else 0.0,
        "pct_positive": float(np.mean(np.array(ics) > 0)),
        "per_fold": [round(v, 4) for v in ics],
    }


# ── Report ───────────────────────────────────────────────────────────────────

def run(data: dict, horizon: int, topk: int) -> dict:
    snaps = build_panel(data, horizon)
    result = {
        "meta": data.get("meta", {}),
        "horizon_h": horizon, "topk": topk,
        "n_symbols": len(data["symbols"]),
        "n_snapshots": len(snaps),
        "ic": per_factor_ic(snaps),
        "deciles": decile_calibration(snaps),
        "walk_forward": walk_forward_ic(snaps, horizon),
    }
    rets, pstats = portfolio_curve(snaps, horizon, topk)
    result["portfolio"] = pstats
    if pstats.get("periods", 0) >= 3:
        result["deflated_sharpe"] = deflated_sharpe(
            pstats["sharpe_annual"], pstats["periods"],
            num_trials=20,        # score has ~20 hand-tuned constants/weights
            skew=pstats["skew"], kurt=pstats["excess_kurtosis"])
    return result


def _fmt_ic(v):
    return "  n/a" if (v is None or not np.isfinite(v)) else f"{v:+.4f}"


def to_markdown(r: dict) -> str:
    m = r["meta"]
    synthetic = m.get("source") == "synthetic"
    L = []
    L.append("# Trade Desk — Score Backtest Report\n")
    if synthetic:
        L.append("> ⚠️ **SYNTHETIC DATASET** — numbers below validate the "
                 "*pipeline*, not the real strategy. Re-run against a Bybit "
                 "dataset for a real verdict.\n")
    L.append(f"- Source: **{m.get('source','?')}**, {m.get('days','?')}d, "
             f"{r['n_symbols']} symbols")
    L.append(f"- Forward horizon: **{r['horizon_h']}h**, "
             f"snapshots scored: **{r['n_snapshots']:,}**\n")

    L.append("## 1. Per-factor edge (Information Coefficient)\n")
    L.append("Spearman rank corr between each factor and the forward return "
             "(long perspective). |IC| ~ 0.03+ is meaningful on this many "
             "samples; near 0 means the factor carries no directional edge.\n")
    L.append("| Factor | IC |")
    L.append("|---|---|")
    for name in F.FACTOR_NAMES:
        L.append(f"| {name} | {_fmt_ic(r['ic'][name])} |")
    L.append(f"| **composite** | **{_fmt_ic(r['ic']['final'])}** |\n")

    L.append("## 2. Composite-score calibration (deciles)\n")
    L.append("Does a higher long score actually mean a higher win-rate / "
             "forward return? A working score is monotonic top-to-bottom.\n")
    L.append("| Decile | Score range | N | Win-rate | Mean fwd % | Median fwd % |")
    L.append("|---|---|---|---|---|---|")
    for d in r["deciles"]:
        L.append(f"| {d['bucket']} | {d['score_lo']:.0f}–{d['score_hi']:.0f} "
                 f"| {d['n']:,} | {d['win_rate']*100:.1f}% "
                 f"| {d['mean_fwd_pct']:+.3f} | {d['median_fwd_pct']:+.3f} |")
    if r["deciles"]:
        top = r["deciles"][-1]["mean_fwd_pct"]
        bot = r["deciles"][0]["mean_fwd_pct"]
        L.append(f"\n**Top-minus-bottom decile spread:** {top - bot:+.3f}% "
                 f"forward return.\n")

    wf = r["walk_forward"]
    L.append("## 3. Walk-forward stability (purged + embargoed)\n")
    if wf.get("folds", 0):
        L.append(f"- Folds: {wf['folds']} | mean OOS IC: **{wf['mean_ic']:+.4f}** "
                 f"| std: {wf['std_ic']:.4f} | positive folds: "
                 f"{wf['pct_positive']*100:.0f}%")
        L.append(f"- Per-fold IC: {wf['per_fold']}\n")
    else:
        L.append("- Not enough data for walk-forward folds.\n")

    p = r["portfolio"]
    L.append(f"## 4. Top-{r['topk']} long/short portfolio ({r['horizon_h']}h, "
             "non-overlapping)\n")
    if p.get("periods", 0) >= 3:
        L.append(f"- Rebalances: {p['periods']} | mean/period: "
                 f"{p['mean_period_pct']:+.3f}% | hit-rate: {p['hit_rate']*100:.1f}%")
        L.append(f"- **Annualized Sharpe: {p['sharpe_annual']:+.2f}** | "
                 f"total: {p['total_return_pct']:+.1f}% | "
                 f"max drawdown: {p['max_drawdown_pct']:.1f}%")
        L.append(f"- Return skew: {p['skew']:+.2f} | excess kurtosis: "
                 f"{p['excess_kurtosis']:+.2f}")
        if "deflated_sharpe" in r:
            dsr = r["deflated_sharpe"]
            verdict = "likely real" if dsr >= 0.95 else "NOT significant (likely overfit / noise)"
            L.append(f"- **Deflated Sharpe p(SR>0): {dsr:.3f}** → {verdict}\n")
    else:
        L.append("- Too few non-overlapping periods to evaluate.\n")

    L.append("## How to read this\n")
    L.append("- **IC near zero across factors** → the score is decorating "
             "noise; tuning weights won't help until factors with real IC are "
             "found (`feature-engineering`, `custom-indicators`).")
    L.append("- **Non-monotonic deciles** → the composite is miscalibrated; "
             "the number shown in the UI doesn't mean what a user assumes.")
    L.append("- **OOS IC flips sign across folds** → no stable edge; any single "
             "backtest number is luck (`walk-forward-validation`).")
    L.append("- **Deflated Sharpe < 0.95** → even a nice-looking Sharpe is "
             "within what 20 hand-tuned knobs would produce by chance.\n")
    return "\n".join(L)


def to_html(md: str, r: dict) -> str:
    # Minimal, self-contained; good enough to open in a browser.
    import html as _h
    body = _h.escape(md)
    return f"""<!doctype html><meta charset=utf-8>
<title>Score Backtest Report</title>
<style>body{{max-width:900px;margin:2rem auto;font:15px/1.5 system-ui;
padding:0 1rem;color:#e6e6e6;background:#111}}pre{{white-space:pre-wrap}}
a{{color:#6cf}}</style><pre>{body}</pre>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="dataset.json")
    ap.add_argument("--horizon", type=int, default=12, help="forward hours")
    ap.add_argument("--topk", type=int, default=5)
    ap.add_argument("--out", default="report")
    a = ap.parse_args()
    data = json.loads(Path(a.dataset).read_text())
    r = run(data, a.horizon, a.topk)
    md = to_markdown(r)
    Path(a.out + ".md").write_text(md)
    Path(a.out + ".html").write_text(to_html(md, r))
    Path(a.out + ".json").write_text(json.dumps(r, indent=2))
    print(md)
    print(f"\nWrote {a.out}.md / .html / .json")


if __name__ == "__main__":
    main()
