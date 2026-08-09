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


def trailing_exit(fh: Sequence[float], fl: Sequence[float], fc: Sequence[float],
                  entry: float, stop: float, direction: int, atr: float,
                  trail_mult: float, cost_frac: float,
                  horizon: int) -> Tuple[Optional[float], int]:
    """Saída por stop dinâmico (chandelier) — coerente com uma entrada de momentum.

    Sem alvo fixo: o stop segue o extremo favorável a `trail_mult`×ATR de
    distância e nunca recua. A posição só fecha quando a tendência se vira
    (stop tocado) ou no limite do horizonte. É isto que deixa correr os
    ganhos — o oposto de cortar no primeiro nível à frente.

    Devolve (R líquido de custos, barras_consumidas).
    """
    risk = abs(entry - stop)
    if not (risk > 0) or not fc:
        return None, 0
    cost_r = cost_frac * entry / risk
    n = min(horizon, len(fc))
    trail = stop
    best = entry
    for i in range(n):
        if direction > 0:
            if fl[i] <= trail:                       # stop tocado
                return (trail - entry) / risk - cost_r, i + 1
            best = max(best, fh[i])
            nt = max(trail, best - trail_mult * atr)
            # Se o nível de trailing já está no preço ou acima dele, a posição
            # sai A MERCADO agora — não fica uma ordem pousada à espera. Deixá-la
            # pousada daria uma opção grátis: se o preço subisse, mantinha-se o
            # ganho; se caísse, saía-se ao preço antigo. Isso é look-ahead.
            if nt >= fc[i]:
                return (fc[i] - entry) / risk - cost_r, i + 1
            trail = nt
        else:
            if fh[i] >= trail:
                return (entry - trail) / risk - cost_r, i + 1
            best = min(best, fl[i])
            nt = min(trail, best + trail_mult * atr)
            if nt <= fc[i]:
                return (entry - fc[i]) / risk - cost_r, i + 1
            trail = nt
    exit_px = fc[n - 1]                              # horizonte → mark-to-close
    raw = (exit_px - entry) / risk if direction > 0 else (entry - exit_px) / risk
    return raw - cost_r, n


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
