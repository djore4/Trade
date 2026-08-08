"""Fase 1 — extrator estrutural.

Funções PURAS, sem chamadas de rede, testáveis com dados sintéticos. Cada nível
devolvido traz uma justificação em texto legível (quantos toques, a que preço, há
quantas barras). Porta fiel da camada em JS (tab SCAN).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Klines:
    """OHLCV cronológico: índice 0 = barra mais antiga, -1 = mais recente."""
    o: List[float] = field(default_factory=list)
    h: List[float] = field(default_factory=list)
    l: List[float] = field(default_factory=list)
    c: List[float] = field(default_factory=list)
    v: List[float] = field(default_factory=list)

    def __len__(self) -> int:  # nº de barras
        return len(self.c)


@dataclass
class Pivot:
    index: int
    price: float
    type: str          # 'high' | 'low'
    bars_ago: int


@dataclass
class Level:
    price: float
    touches: int
    last_bars_ago: int
    kind: str          # 'suporte' | 'resistência'
    why: str


@dataclass
class RangeBounds:
    hi: float
    lo: float
    mid: float
    span: float
    price: float
    pos: float         # 0 = fundo do range, 1 = topo
    why: str


def atr(k: Klines, n: int = 14) -> Optional[float]:
    """ATR de Wilder. Devolve o último valor ou None se a série for curta."""
    N = len(k.c)
    if N < n + 1:
        return None
    tr = []
    for i in range(1, N):
        tr.append(max(k.h[i] - k.l[i], abs(k.h[i] - k.c[i - 1]), abs(k.l[i] - k.c[i - 1])))
    a = sum(tr[:n]) / n
    for i in range(n, len(tr)):
        a = (a * (n - 1) + tr[i]) / n
    return a


def swing_pivots(k: Klines, left: int = 3, right: int = 3) -> List[Pivot]:
    """Pivots fractais CONFIRMADOS (não repintam).

    Um topo em i é pivot se h[i] for o máximo ESTRITO da janela [i-left, i+right];
    só é confirmado quando existem 'right' barras à direita. Idem para fundos.
    """
    N = len(k.c)
    piv: List[Pivot] = []
    for i in range(left, N - right):          # i < N-right ⇒ confirmado, sem repaint
        is_hi = is_lo = True
        for j in range(i - left, i + right + 1):
            if j == i:
                continue
            if k.h[j] >= k.h[i]:
                is_hi = False
            if k.l[j] <= k.l[i]:
                is_lo = False
        bars_ago = (N - 1) - i
        if is_hi:
            piv.append(Pivot(i, k.h[i], "high", bars_ago))
        if is_lo:
            piv.append(Pivot(i, k.l[i], "low", bars_ago))
    return piv


def cluster_levels(pivots: List[Pivot], tol: float) -> List[Level]:
    """Agrupa pivots próximos (dentro de 'tol' em preço) e conta toques."""
    if not pivots or not (tol > 0):
        return []
    by_price = sorted(pivots, key=lambda p: p.price)
    clusters: List[List[Pivot]] = []
    cur = [by_price[0]]
    for p in by_price[1:]:
        ref = sum(x.price for x in cur) / len(cur)
        if abs(p.price - ref) <= tol:
            cur.append(p)
        else:
            clusters.append(cur)
            cur = [p]
    clusters.append(cur)

    out: List[Level] = []
    for g in clusters:
        price = sum(p.price for p in g) / len(g)
        touches = len(g)
        last_bars_ago = min(p.bars_ago for p in g)
        n_hi = sum(1 for p in g if p.type == "high")
        kind = "resistência" if n_hi >= touches - n_hi else "suporte"
        bars_list = ", ".join(str(b) for b in sorted(p.bars_ago for p in g))
        why = (f"{touches} toque(s) ~ {price:.6g} — {kind}; "
               f"toque mais recente há {last_bars_ago} barras (todos: há {bars_list} barras)")
        out.append(Level(price, touches, last_bars_ago, kind, why))
    out.sort(key=lambda L: L.price)
    return out


def range_bounds(k: Klines, lookback: int = 96) -> RangeBounds:
    """Limites do range recente + posição relativa do preço no range."""
    N = len(k.c)
    s = max(0, N - lookback)
    hi = max(k.h[s:])
    lo = min(k.l[s:])
    price = k.c[N - 1]
    span = hi - lo
    pos = (price - lo) / span if span > 0 else 0.5
    why = (f"range de {N - s} barras: {lo:.6g}–{hi:.6g}; "
           f"preço {price:.6g} no percentil {pos * 100:.0f}%")
    return RangeBounds(hi, lo, (hi + lo) / 2, span, price, pos, why)
