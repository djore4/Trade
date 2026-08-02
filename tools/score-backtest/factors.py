"""Faithful Python port of the 7-factor scoring engine in index.html.

Every function here mirrors, line-for-line, the JavaScript in `index.html`
(functions `trd*` around lines 1778-1889). The port is deliberately literal —
same constants, same clamp bounds, same branch order — so that a backtest of
this code is a backtest of the *actual* Trade Desk scanner, not an
approximation. `test_parity.py` pins the numeric equivalence.

Perspective convention (unchanged from the JS): each factor returns 0..100 from
the LONG point of view; the short side is the mirror, handled in `trd_score`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional


def trd_clamp(v: float, lo: float, hi: float) -> float:
    """index.html:1778 — const trdClamp = (v, lo, hi) => max(lo, min(hi, v))."""
    return max(lo, min(hi, v))


def trd_ema(vals, period: int) -> Optional[float]:
    """index.html:1791 — EMA over chronological closes; returns the last value.

    Seeds with the simple mean of the first `period` values, then applies the
    standard EMA recursion. Returns None when there is not enough data.
    """
    if not vals or len(vals) < period:
        return None
    k = 2 / (period + 1)
    e = sum(vals[:period]) / period
    for i in range(period, len(vals)):
        e = vals[i] * k + e * (1 - k)
    return e


def trd_rsi(vals, period: int = 14) -> Optional[float]:
    """index.html:1800 — Wilder's RSI over chronological closes, 0..100."""
    if not vals or len(vals) < period + 1:
        return None
    gain = 0.0
    loss = 0.0
    for i in range(1, period + 1):
        d = vals[i] - vals[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    ag = gain / period
    al = loss / period
    for i in range(period + 1, len(vals)):
        d = vals[i] - vals[i - 1]
        ag = (ag * (period - 1) + max(d, 0)) / period
        al = (al * (period - 1) + max(-d, 0)) / period
    if al == 0:
        return 100.0
    rs = ag / al
    return 100 - 100 / (1 + rs)


# ── Factors (each returns 0..100 from the LONG perspective) ──────────────────

def trd_f_mom_long(chg: float) -> float:
    """index.html:1819 — momentum from 24h % change."""
    if chg <= 0:
        return trd_clamp(50 + chg * 3, 5, 50)      # falling: weak for long
    if chg <= 6:
        return trd_clamp(50 + chg * 7, 50, 92)      # healthy rise
    return trd_clamp(92 - (chg - 6) * 2.5, 45, 92)  # stretched: penalise


def trd_f_rsi_long(rsi: Optional[float]) -> float:
    """index.html:1824 — RSI factor."""
    if rsi is None:
        return 50
    if rsi < 30:
        return 62
    if rsi < 45:
        return 56
    if rsi <= 65:
        return trd_clamp(70 + (rsi - 45), 70, 90)   # ideal zone
    if rsi <= 75:
        return 58
    return trd_clamp(45 - (rsi - 75) * 2, 15, 45)   # overbought: risky long


def trd_f_fund_long(fr: float) -> float:
    """index.html:1832 — funding factor (fr in %); negative funding favours long."""
    return trd_clamp(50 - fr * 500, 8, 88)


def trd_f_fund_short(fr: float) -> float:
    """index.html:1880 — short-side mirror: clamp(50 + fr*500, 8, 88)."""
    return trd_clamp(50 + fr * 500, 8, 88)


def trd_f_vol(turn: float) -> float:
    """index.html:1835 — turnover/liquidity factor ($1M->0, $1B->100)."""
    if not turn or turn <= 0:
        return 0
    return trd_clamp((math.log10(turn) - 6) / 3 * 100, 0, 100)


def trd_breakout(c: "Cand", side: str) -> float:
    """index.html:1840 — proximity to a recent high (long) / low (short)."""
    if c.hi is None or c.lo is None or not c.price:
        return 50
    if side == "short":
        d = (c.price - c.lo) / c.price * 100
        return trd_clamp(92 - d * 9, 10, 95)
    d = (c.hi - c.price) / c.price * 100
    return trd_clamp(92 - d * 9, 10, 95)


def trd_oi_factor(c: "Cand", side: str) -> float:
    """index.html:1850 — open-interest confirmation of the move."""
    if c.oi_chg is None:
        return 50
    up = c.chg > 0
    oi_up = c.oi_chg > 0
    if side == "short":
        if (not up) and oi_up:
            return trd_clamp(62 + c.oi_chg * 2, 62, 95)     # price down + OI up = new shorts
        if (not up) and (not oi_up):
            return trd_clamp(52 + c.oi_chg * 0.5, 42, 60)   # long liquidation (weaker)
        if up and oi_up:
            return trd_clamp(40 - c.oi_chg, 12, 42)         # new longs, against the short
        return 46
    if up and oi_up:
        return trd_clamp(62 + c.oi_chg * 2, 62, 95)         # price up + OI up = new longs
    if up and (not oi_up):
        return trd_clamp(52 + c.oi_chg * 0.5, 42, 60)       # short-covering rise (weaker)
    if (not up) and oi_up:
        return trd_clamp(40 - c.oi_chg, 12, 42)             # new shorts, against the long
    return 46


def trd_trend(c: "Cand", side: str) -> float:
    """index.html:1868 — trend (0..100) from EMA 9/21 on 1h."""
    if c.ef is None or c.es is None or not c.es:
        return 50
    a = (c.price - c.ef) / c.es * 100
    b = (c.ef - c.es) / c.es * 100
    bull = trd_clamp(50 + a * 8 + b * 12, 0, 100)
    return 100 - bull if side == "short" else bull


# index.html:1865 — factor weights (sum = 1.0).
TRD_W = {"mom": 0.15, "trend": 0.17, "rsi": 0.12, "fund": 0.12,
         "vol": 0.11, "brk": 0.16, "oi": 0.17}


@dataclass
class Cand:
    """A candidate snapshot — the `c` object the JS builds per symbol/instant."""
    symbol: str = ""
    coin: str = ""
    price: float = 0.0
    chg: float = 0.0          # 24h % change
    fr: float = 0.0           # funding rate, %
    turnover: float = 0.0     # 24h quote turnover, USD
    oi_usd: float = 0.0
    ef: Optional[float] = None       # EMA 9 (1h)
    es: Optional[float] = None       # EMA 21 (1h)
    rsi: Optional[float] = None
    hi: Optional[float] = None       # 48-bar prior high
    lo: Optional[float] = None       # 48-bar prior low
    vol_spike: float = 1.0
    oi_chg: Optional[float] = None   # 24h OI % change


@dataclass
class ScoreBreakdown:
    final: int
    mom: float
    trend: float
    rsi: float
    fund: float
    vol: float
    brk: float
    oi: float


def trd_score(c: Cand, side: str) -> ScoreBreakdown:
    """index.html:1876 — build the 7 factors + composite score for a side."""
    mom = trd_f_mom_long(-c.chg) if side == "short" else trd_f_mom_long(c.chg)
    trend = trd_trend(c, side)
    if side == "short":
        rsi = trd_f_rsi_long(None if c.rsi is None else 100 - c.rsi)
    else:
        rsi = trd_f_rsi_long(c.rsi)
    fund = trd_f_fund_short(c.fr) if side == "short" else trd_f_fund_long(c.fr)
    vol = trd_f_vol(c.turnover)
    brk = trd_breakout(c, side)
    oi = trd_oi_factor(c, side)
    final = (mom * TRD_W["mom"] + trend * TRD_W["trend"] + rsi * TRD_W["rsi"]
             + fund * TRD_W["fund"] + vol * TRD_W["vol"] + brk * TRD_W["brk"]
             + oi * TRD_W["oi"])
    if c.vol_spike >= 1.8:
        final += trd_clamp((c.vol_spike - 1.8) * 4, 0, 8)
    # JS Math.round is floor(x + 0.5) (round-half-up), not Python's
    # round-half-to-even — match it so an exact X.5 lands identically.
    return ScoreBreakdown(
        final=int(math.floor(trd_clamp(final, 0, 100) + 0.5)),
        mom=mom, trend=trend, rsi=rsi, fund=fund, vol=vol, brk=brk, oi=oi,
    )


# The seven named factor values for a side, used by the backtest for per-factor IC.
FACTOR_NAMES = ["mom", "trend", "rsi", "fund", "vol", "brk", "oi"]


def factor_vector(c: Cand, side: str) -> dict:
    sb = trd_score(c, side)
    return {"mom": sb.mom, "trend": sb.trend, "rsi": sb.rsi, "fund": sb.fund,
            "vol": sb.vol, "brk": sb.brk, "oi": sb.oi, "final": sb.final}
