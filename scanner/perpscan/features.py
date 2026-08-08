"""Bateria de indicadores em versão ROLANTE (secção 7.2).

Todos os indicadores são pré-calculados como arrays de comprimento N, onde o
valor no índice `i` usa **apenas** dados até `i` (inclusive). Não há look-ahead
por construção, e não há limite de janela — o que permite indicadores lentos
como a Bull Market Support Band (20 semanas) sem inflacionar a janela de análise.

Usado pelo estudo de features (`study.py`): em vez de escolher filtros a olho,
mede-se o que cada indicador vale contra o resultado real das trades.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional

from .structure import Klines

# Barras por semana, por timeframe (para indicadores semanais como a BMSB)
BARS_PER_WEEK = {"15": 672, "30": 336, "60": 168, "120": 84, "240": 42,
                 "360": 28, "720": 14, "D": 7}


# ── Primitivas rolantes ───────────────────────────────────────────────────────
def _sma(vals: List[float], n: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(vals)
    s = 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= n:
            s -= vals[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def _ema(vals: List[float], n: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(vals)
    if len(vals) < n:
        return out
    k = 2.0 / (n + 1)
    e = sum(vals[:n]) / n
    out[n - 1] = e
    for i in range(n, len(vals)):
        e = vals[i] * k + e * (1 - k)
        out[i] = e
    return out


def _rolling_std(vals: List[float], n: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(vals)
    s = s2 = 0.0
    for i, v in enumerate(vals):
        s += v
        s2 += v * v
        if i >= n:
            o = vals[i - n]
            s -= o
            s2 -= o * o
        if i >= n - 1:
            var = max(0.0, s2 / n - (s / n) ** 2)
            out[i] = math.sqrt(var)
    return out


def _wilder(vals: List[float], n: int, start: int = 0) -> List[Optional[float]]:
    """Suavização de Wilder rolante (usada por RSI/ATR/ADX)."""
    out: List[Optional[float]] = [None] * len(vals)
    if len(vals) < start + n:
        return out
    a = sum(vals[start:start + n]) / n
    out[start + n - 1] = a
    for i in range(start + n, len(vals)):
        a = (a * (n - 1) + vals[i]) / n
        out[i] = a
    return out


# ── Indicadores ───────────────────────────────────────────────────────────────
def rsi_series(c: List[float], n: int = 14) -> List[Optional[float]]:
    N = len(c)
    gains = [0.0] * N
    losses = [0.0] * N
    for i in range(1, N):
        d = c[i] - c[i - 1]
        gains[i] = max(d, 0.0)
        losses[i] = max(-d, 0.0)
    ag = _wilder(gains, n, start=1)
    al = _wilder(losses, n, start=1)
    out: List[Optional[float]] = [None] * N
    for i in range(N):
        if ag[i] is None or al[i] is None:
            continue
        out[i] = 100.0 if al[i] == 0 else 100.0 - 100.0 / (1.0 + ag[i] / al[i])
    return out


def atr_series(k: Klines, n: int = 14) -> List[Optional[float]]:
    N = len(k.c)
    tr = [0.0] * N
    for i in range(1, N):
        tr[i] = max(k.h[i] - k.l[i], abs(k.h[i] - k.c[i - 1]), abs(k.l[i] - k.c[i - 1]))
    return _wilder(tr, n, start=1)


def adx_series(k: Klines, n: int = 14) -> List[Optional[float]]:
    """ADX rolante. Devolve também +DI/−DI através de adx_di_series se preciso."""
    return adx_di_series(k, n)[0]


def adx_di_series(k: Klines, n: int = 14):
    N = len(k.c)
    tr = [0.0] * N
    pdm = [0.0] * N
    mdm = [0.0] * N
    for i in range(1, N):
        up = k.h[i] - k.h[i - 1]
        dn = k.l[i - 1] - k.l[i]
        pdm[i] = up if (up > dn and up > 0) else 0.0
        mdm[i] = dn if (dn > up and dn > 0) else 0.0
        tr[i] = max(k.h[i] - k.l[i], abs(k.h[i] - k.c[i - 1]), abs(k.l[i] - k.c[i - 1]))
    trs = _wilder(tr, n, start=1)
    ps = _wilder(pdm, n, start=1)
    ms = _wilder(mdm, n, start=1)
    dx: List[float] = [0.0] * N
    pdi_o: List[Optional[float]] = [None] * N
    mdi_o: List[Optional[float]] = [None] * N
    first = None
    for i in range(N):
        if trs[i] is None or not trs[i]:
            continue
        pdi = 100.0 * ps[i] / trs[i]
        mdi = 100.0 * ms[i] / trs[i]
        pdi_o[i] = pdi
        mdi_o[i] = mdi
        dx[i] = 100.0 * abs(pdi - mdi) / ((pdi + mdi) or 1e-9)
        if first is None:
            first = i
    adx_o: List[Optional[float]] = [None] * N
    if first is not None and N - first >= n:
        a = sum(dx[first:first + n]) / n
        adx_o[first + n - 1] = a
        for i in range(first + n, N):
            a = (a * (n - 1) + dx[i]) / n
            adx_o[i] = a
    return adx_o, pdi_o, mdi_o


def macd_series(c: List[float], fast: int = 12, slow: int = 26, sig: int = 9):
    ef = _ema(c, fast)
    es = _ema(c, slow)
    N = len(c)
    line: List[Optional[float]] = [None] * N
    for i in range(N):
        if ef[i] is not None and es[i] is not None:
            line[i] = ef[i] - es[i]
    idx = [i for i, v in enumerate(line) if v is not None]
    signal: List[Optional[float]] = [None] * N
    hist: List[Optional[float]] = [None] * N
    if idx:
        vals = [line[i] for i in idx]
        sg = _ema(vals, sig)
        for j, i in enumerate(idx):
            signal[i] = sg[j]
            if sg[j] is not None:
                hist[i] = line[i] - sg[j]
    return line, signal, hist


def bollinger_series(c: List[float], n: int = 20, k_sd: float = 2.0):
    """Devolve (%B, largura relativa). %B = posição do preço na banda (0–1)."""
    m = _sma(c, n)
    sd = _rolling_std(c, n)
    N = len(c)
    pctb: List[Optional[float]] = [None] * N
    width: List[Optional[float]] = [None] * N
    for i in range(N):
        if m[i] is None or sd[i] is None or m[i] == 0:
            continue
        up = m[i] + k_sd * sd[i]
        lo = m[i] - k_sd * sd[i]
        rng = up - lo
        if rng > 0:
            pctb[i] = (c[i] - lo) / rng
        width[i] = rng / m[i]
    return pctb, width


# ── Vetor de features num ponto de decisão ────────────────────────────────────
def precompute_features(k: Klines, tf: str = "240") -> Dict[str, List[Optional[float]]]:
    """Todos os indicadores em arrays rolantes. Índice i usa só dados até i."""
    c, v = k.c, k.v
    N = len(c)
    bpw = BARS_PER_WEEK.get(tf, 42)

    atr = atr_series(k, 14)
    adx, pdi, mdi = adx_di_series(k, 14)
    rsi14 = rsi_series(c, 14)
    macd_l, macd_s, macd_h = macd_series(c)
    pctb, bwidth = bollinger_series(c, 20, 2.0)
    ema21 = _ema(c, 21)
    ema50 = _ema(c, 50)
    ema200 = _ema(c, 200)
    sma50 = _sma(c, 50)
    sma200 = _sma(c, 200)
    # Bull Market Support Band: SMA 20 semanas + EMA 21 semanas
    bmsb_sma = _sma(c, 20 * bpw) if N > 20 * bpw else [None] * N
    bmsb_ema = _ema(c, 21 * bpw) if N > 21 * bpw else [None] * N
    vol_sma = _sma(v, 20)
    vol_sd = _rolling_std(v, 20)

    def rel(a: List[Optional[float]]) -> List[Optional[float]]:
        """Distância relativa do preço ao indicador, normalizada por ATR."""
        out: List[Optional[float]] = [None] * N
        for i in range(N):
            if a[i] is not None and atr[i]:
                out[i] = (c[i] - a[i]) / atr[i]
        return out

    feats: Dict[str, List[Optional[float]]] = {
        "rsi14": rsi14,
        "adx14": adx,
        "di_spread": [None if (pdi[i] is None or mdi[i] is None) else pdi[i] - mdi[i]
                      for i in range(N)],
        "macd_hist_atr": [None if (macd_h[i] is None or not atr[i]) else macd_h[i] / atr[i]
                          for i in range(N)],
        "bb_pctb": pctb,
        "bb_width": bwidth,
        "dist_ema21": rel(ema21),
        "dist_ema50": rel(ema50),
        "dist_ema200": rel(ema200),
        "dist_sma50": rel(sma50),
        "dist_sma200": rel(sma200),
        "dist_bmsb_sma": rel(bmsb_sma),
        "dist_bmsb_ema": rel(bmsb_ema),
        "vol_ratio": [None if (vol_sma[i] is None or not vol_sma[i]) else v[i] / vol_sma[i]
                      for i in range(N)],
        "vol_z": [None if (vol_sma[i] is None or not vol_sd[i]) else
                  (v[i] - vol_sma[i]) / vol_sd[i] for i in range(N)],
        "atr_pct": [None if (not atr[i] or not c[i]) else atr[i] / c[i] for i in range(N)],
    }
    # Momentum simples em várias janelas (retorno normalizado por ATR)
    for w in (6, 24, 72):
        arr: List[Optional[float]] = [None] * N
        for i in range(w, N):
            if atr[i]:
                arr[i] = (c[i] - c[i - w]) / atr[i]
        feats[f"mom_{w}"] = arr
    return feats


def features_at(feats: Dict[str, List[Optional[float]]], i: int,
                direction: int) -> Dict[str, float]:
    """Lê o vetor de features na barra i.

    Os indicadores direcionais são orientados **a favor do trade**: um valor alto
    significa "mais forte na direção da posição", para LONG e SHORT. Sem isto, a
    média de um SHORT cancelaria a de um LONG e o sinal desapareceria.
    """
    DIRECTIONAL = {"di_spread", "macd_hist_atr", "dist_ema21", "dist_ema50",
                   "dist_ema200", "dist_sma50", "dist_sma200", "dist_bmsb_sma",
                   "dist_bmsb_ema", "mom_6", "mom_24", "mom_72"}
    out: Dict[str, float] = {}
    for name, arr in feats.items():
        val = arr[i] if i < len(arr) else None
        if val is None:
            continue
        if name in DIRECTIONAL:
            val = val * direction
        elif name == "rsi14" and direction < 0:
            val = 100.0 - val          # 'esticado a favor do trade' nos dois lados
        elif name == "bb_pctb" and direction < 0:
            val = 1.0 - val
        out[name] = val
    return out
