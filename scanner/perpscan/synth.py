"""Geradores de séries sintéticas para testes (Fase 1/2).

Espelham os construtores usados na tab SCAN em JS.
"""
from __future__ import annotations

from .structure import Klines


def synth_range(n: int = 200, lo: float = 100.0, hi: float = 120.0,
                period: int = 20, end_frac: float = 0.03) -> Klines:
    """Range em zig-zag: toca lo e hi repetidamente (níveis confirmáveis).

    `end_frac` fixa a posição final do preço no range (0 = fundo, 1 = topo).
    """
    o, h, l, c = [], [], [], []
    span = hi - lo
    for i in range(n):
        seg = i // period
        up = seg % 2 == 0
        t = (i % period) / period
        px = lo + span * t if up else hi - span * t   # triângulo com declive
        op = c[i - 1] if i else px
        w = 0.15 * (span / 20)
        o.append(op)
        c.append(px)
        h.append(px + w)                               # wick baseado no próprio preço
        l.append(px - w)
    end_px = lo + span * end_frac
    c[n - 1] = end_px
    h[n - 1] = end_px + 0.1 * (span / 20)
    l[n - 1] = end_px - 0.1 * (span / 20)
    return Klines(o=o, h=h, l=l, c=c, v=[1.0] * n)


def synth_trend(n: int = 200, start: float = 100.0, step: float = 0.5) -> Klines:
    """Tendência monotónica: sem topos/fundos locais → nenhum nível confirmável."""
    o, h, l, c = [], [], [], []
    for i in range(n):
        px = start + step * i
        o.append(px - step / 2)
        c.append(px)
        h.append(px + 0.2)
        l.append(px - step / 2 - 0.2)
    return Klines(o=o, h=h, l=l, c=c, v=[1.0] * n)
