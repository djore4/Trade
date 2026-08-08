"""Estudo de features (secção 7.2) — que indicadores têm mesmo sinal?

Em vez de escolher filtros a olho (o que já falhou: a triagem ADX/RSI/volume
baixou a vantagem bruta em 30%), este módulo **mede** cada indicador contra o
resultado real das trades aprovadas pelo gate.

Método, e por que é assim:

- Para cada setup aprovado regista-se o vetor de features no momento da decisão
  (só com dados passados) e o R realizado, líquido de custos.
- Cada feature é dividida em **tercis**; compara-se o R médio do tercil de cima
  com o de baixo (Welch), e mede-se a **correlação de Spearman** com o R.
- **Correção para testes múltiplos (Benjamini-Hochberg).** Testar 20 indicadores
  dá 20 oportunidades de encontrar sinal por acaso: com p<0.05, espera-se 1
  "descoberta" falsa só por sorte. Sem esta correção, o estudo produziria
  indicadores falsos com aparência científica.
- Corre **só em DEV**. O holdout continua fechado.

O resultado é um mapa honesto: o que tem sinal, o que não tem, e o que é ruído
com boa aparência.
"""
from __future__ import annotations

import math
from statistics import mean
from typing import Dict, List, Sequence, Tuple

from .backtest import stddev, welch


def spearman(x: Sequence[float], y: Sequence[float]) -> float:
    """Correlação de postos (robusta a outliers e a relações não-lineares)."""
    n = len(x)
    if n < 3:
        return 0.0

    def ranks(v: Sequence[float]) -> List[float]:
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0          # postos médios nos empates
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(x), ranks(y)
    mx, my = mean(rx), mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else 0.0


def benjamini_hochberg(pvals: List[float], q: float = 0.10) -> List[bool]:
    """Controlo da taxa de falsas descobertas. Devolve quais sobrevivem."""
    m = len(pvals)
    if not m:
        return []
    order = sorted(range(m), key=lambda i: pvals[i])
    keep = [False] * m
    kmax = -1
    for rank, i in enumerate(order, start=1):
        if pvals[i] <= q * rank / m:
            kmax = rank
    for rank, i in enumerate(order, start=1):
        if rank <= kmax:
            keep[i] = True
    return keep


def analyse(records: List[Tuple[Dict[str, float], float]], q: float = 0.10) -> dict:
    """records: lista de (features, R). Devolve o estudo por feature."""
    names = sorted({k for f, _ in records for k in f})
    rows = []
    for name in names:
        pairs = [(f[name], r) for f, r in records if name in f]
        if len(pairs) < 60:                     # amostra insuficiente para concluir
            continue
        pairs.sort(key=lambda p: p[0])
        n = len(pairs)
        lo = [r for _, r in pairs[:n // 3]]
        hi = [r for _, r in pairs[-(n // 3):]]
        mid = [r for _, r in pairs[n // 3:-(n // 3)]] or [0.0]
        t, p = welch(hi, lo)
        rho = spearman([v for v, _ in pairs], [r for _, r in pairs])
        rows.append({
            "name": name, "n": n,
            "lo": mean(lo), "mid": mean(mid), "hi": mean(hi),
            "delta": mean(hi) - mean(lo), "t": t, "p": p, "rho": rho,
            "lo_edge": (pairs[n // 3 - 1][0]), "hi_edge": (pairs[-(n // 3)][0]),
        })
    keep = benjamini_hochberg([r["p"] for r in rows], q)
    for r, k in zip(rows, keep):
        r["survives"] = k
    rows.sort(key=lambda r: r["p"])
    return {"rows": rows, "q": q, "n_tested": len(rows),
            "n_survive": sum(1 for r in rows if r["survives"])}


def format_study(res: dict, total_trades: int) -> str:
    rows = res["rows"]
    L = []
    L.append(f"ESTUDO DE FEATURES — {total_trades} trades, {res['n_tested']} indicadores testados")
    L.append("Alvo: R BRUTO (antes de custos). O R líquido subtrai custo/stop_pct, o que")
    L.append("ordena mecanicamente as perdas pelo tamanho do stop e criaria sinal falso.")
    L.append(f"Correção para testes múltiplos: Benjamini-Hochberg, FDR q={res['q']:.2f}")
    L.append("")
    L.append(f"{'indicador':<18}{'R tercil↓':>10}{'R médio':>9}{'R tercil↑':>10}"
             f"{'Δ':>8}{'rho':>7}{'p':>10}  sobrevive")
    L.append("-" * 82)
    for r in rows:
        L.append(f"{r['name']:<18}{r['lo']:>10.3f}{r['mid']:>9.3f}{r['hi']:>10.3f}"
                 f"{r['delta']:>8.3f}{r['rho']:>7.2f}{r['p']:>10.2e}"
                 f"  {'SIM' if r['survives'] else '—'}")
    L.append("")
    if res["n_survive"] == 0:
        L.append("NENHUM indicador sobrevive à correção para testes múltiplos.")
        L.append("Leitura honesta: com esta amostra, nenhum destes indicadores separa")
        L.append("trades boas de más de forma distinguível do acaso. Construir um filtro")
        L.append("a partir dos 'melhores' desta tabela seria escolher ruído — foi")
        L.append("exactamente o que aconteceu com a triagem ADX/RSI/volume.")
    else:
        surv = [r['name'] for r in rows if r['survives']]
        L.append(f"Sobrevivem {res['n_survive']}: {', '.join(surv)}")
        L.append("Estes são candidatos a filtro — mas o valor só é real se se")
        L.append("confirmar no holdout, que continua fechado.")
    return "\n".join(L)
