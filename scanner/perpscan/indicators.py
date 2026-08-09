"""Indicadores de análise técnica para a camada de triagem (secção 7).

Funções PURAS sobre klines. Não criam setups — apenas filtram os que o gate já
aprovou. Todos os limiares usados são valores de manual (ADX 25, RSI 70/30), não
números procurados nos dados.
"""
from __future__ import annotations

from typing import List, Optional

from .structure import Klines


def rsi(k: Klines, n: int = 14) -> Optional[float]:
    """RSI de Wilder sobre os fechos. Devolve o último valor (0–100)."""
    c = k.c
    if len(c) < n + 1:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        ag = (ag * (n - 1) + max(d, 0.0)) / n
        al = (al * (n - 1) + max(-d, 0.0)) / n
    if al == 0:
        return 100.0
    rs = ag / al
    return 100.0 - 100.0 / (1.0 + rs)


def adx(k: Klines, n: int = 14) -> Optional[float]:
    """ADX de Wilder — força da tendência (não a direção). Último valor."""
    h, l, c = k.h, k.l, k.c
    N = len(c)
    if N < 2 * n + 2:
        return None
    tr: List[float] = []
    pdm: List[float] = []
    mdm: List[float] = []
    for i in range(1, N):
        up = h[i] - h[i - 1]
        dn = l[i - 1] - l[i]
        pdm.append(up if (up > dn and up > 0) else 0.0)
        mdm.append(dn if (dn > up and dn > 0) else 0.0)
        tr.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))

    def wilder(arr: List[float]) -> List[float]:
        s = sum(arr[:n])
        out = [s]
        for i in range(n, len(arr)):
            s = s - s / n + arr[i]
            out.append(s)
        return out

    trs, ps, ms = wilder(tr), wilder(pdm), wilder(mdm)
    dx: List[float] = []
    for i in range(len(trs)):
        t = trs[i] or 1e-9
        pdi = 100.0 * ps[i] / t
        mdi = 100.0 * ms[i] / t
        dx.append(100.0 * abs(pdi - mdi) / ((pdi + mdi) or 1e-9))
    if len(dx) < n:
        return None
    a = sum(dx[:n]) / n
    for i in range(n, len(dx)):
        a = (a * (n - 1) + dx[i]) / n
    return a


def volume_ratio(k: Klines, n: int = 20) -> Optional[float]:
    """Volume da última barra / média das n anteriores. >1 = acima do normal."""
    v = k.v
    if len(v) < n + 1:
        return None
    base = sum(v[-n - 1:-1]) / n
    if base <= 0:
        return None
    return v[-1] / base
