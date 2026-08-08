"""Fase 3 — avaliação por barreira tripla + estatística (secção 6.3 e 8)."""
from __future__ import annotations

import math
from statistics import mean, median, pstdev
from typing import List, Optional, Sequence, Tuple


def triple_barrier_ex(fh: Sequence[float], fl: Sequence[float], fc: Sequence[float],
                      entry: float, stop: float, tp: float, direction: int,
                      cost_frac: float, horizon: int) -> Tuple[Optional[float], int]:
    """Barreira tripla líquida de custos. Devolve (R, barras_consumidas).

    fh/fl/fc: futuros (após a entrada). cost_frac: round-trip em fração de preço.
    barras_consumidas permite impor trades NÃO-sobrepostas na validação.
    """
    risk = abs(entry - stop)
    if not (risk > 0) or not fc:
        return None, 0
    cost_r = cost_frac * entry / risk                 # custos em unidades de R
    n = min(horizon, len(fc))
    for i in range(n):
        if direction > 0:
            if fl[i] <= stop:
                return -1 - cost_r, i + 1
            if fh[i] >= tp:
                return (tp - entry) / risk - cost_r, i + 1
        else:
            if fh[i] >= stop:
                return -1 - cost_r, i + 1
            if fl[i] <= tp:
                return (entry - tp) / risk - cost_r, i + 1
    exit_px = fc[n - 1]                                # timeout → mark-to-close
    raw = (exit_px - entry) / risk if direction > 0 else (entry - exit_px) / risk
    return raw - cost_r, n


def triple_barrier(fh: Sequence[float], fl: Sequence[float], fc: Sequence[float],
                   entry: float, stop: float, tp: float, direction: int,
                   cost_frac: float, horizon: int) -> Optional[float]:
    """Compat: só o R da barreira tripla (ver triple_barrier_ex)."""
    return triple_barrier_ex(fh, fl, fc, entry, stop, tp, direction, cost_frac, horizon)[0]


def stddev(a: Sequence[float]) -> float:
    """Desvio-padrão amostral (n-1); 0 se < 2 elementos."""
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def pct_positive(a: Sequence[float]) -> float:
    return (sum(1 for x in a if x > 0) / len(a) * 100.0) if a else 0.0


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def welch(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float]:
    """Teste t de Welch. Devolve (t, p) com p bicaudal (aprox. normal)."""
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return 0.0, 1.0
    va, vb = stddev(a) ** 2, stddev(b) ** 2
    se = math.sqrt(va / na + vb / nb)
    if not (se > 0):
        return 0.0, 1.0
    t = (mean(a) - mean(b)) / se
    p = 2 * (1 - _norm_cdf(abs(t)))
    return t, max(0.0, min(1.0, p))


def summary(a: Sequence[float]) -> dict:
    return {
        "n": len(a),
        "mean": mean(a) if a else 0.0,
        "median": median(a) if a else 0.0,
        "std": stddev(a),
        "pos": pct_positive(a),
    }
