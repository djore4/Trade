"""Simulador de cenários (§M5): DCA linear vs DCA + reserva de volatilidade.

Objetivo é comparar o RELATIVO entre as duas estratégias sobre a MESMA
trajetória de preços — nunca prever preços nem apresentar retornos absolutos
como previsão.

Trajetória = lista de preços (um por período). A reserva é destacada em quedas
segundo a escada, medindo a queda face ao máximo acumulado da trajetória (a
"janela" natural da simulação).
"""
from .ladder import multiplicador


def _dca_linear(precos: list, budget: float) -> dict:
    n = len(precos)
    por_periodo = budget / n if n else 0
    unidades = 0.0
    investido = 0.0
    for p in precos:
        if p > 0:
            unidades += por_periodo / p
            investido += por_periodo
    preco_final = precos[-1] if precos else 0
    valor_final = unidades * preco_final
    return {
        "investido": round(investido, 2),
        "unidades": unidades,
        "preco_medio": round(investido / unidades, 6) if unidades else None,
        "valor_final": round(valor_final, 2),
    }


def _dca_reserva(precos: list, budget: float, base_frac: float, e1: float, e2: float, e3: float) -> dict:
    """~base_frac do budget entra em calendário; o resto é reserva, destacada em quedas."""
    n = len(precos)
    base_total = budget * base_frac
    reserva_total = budget - base_total
    base_por_periodo = base_total / n if n else 0
    base_step = base_por_periodo  # unidade de compra base para a escada

    unidades = 0.0
    investido = 0.0
    reserva_restante = reserva_total
    high = 0.0
    for p in precos:
        if p <= 0:
            continue
        high = max(high, p)
        # compra base (calendário)
        unidades += base_por_periodo / p
        investido += base_por_periodo
        # reserva (preço) — escada face ao máximo acumulado
        drawdown = (high - p) / high * 100.0 if high else 0
        mult = multiplicador(drawdown, e1, e2, e3)
        if mult > 0 and reserva_restante > 0:
            gasto = min(mult * base_step, reserva_restante)
            unidades += gasto / p
            investido += gasto
            reserva_restante -= gasto

    preco_final = precos[-1] if precos else 0
    valor_final = unidades * preco_final
    return {
        "investido": round(investido, 2),
        "reserva_por_gastar": round(reserva_restante, 2),
        "unidades": unidades,
        "preco_medio": round(investido / unidades, 6) if unidades else None,
        "valor_final": round(valor_final, 2),
    }


def compara(precos: list, budget: float, base_frac: float, e1: float, e2: float, e3: float) -> dict:
    linear = _dca_linear(precos, budget)
    reserva = _dca_reserva(precos, budget, base_frac, e1, e2, e3)

    diff_valor = (reserva["valor_final"] or 0) - (linear["valor_final"] or 0)
    diff_unidades = (reserva["unidades"] or 0) - (linear["unidades"] or 0)
    return {
        "linear": linear,
        "reserva": reserva,
        "diferenca": {
            "valor_final": round(diff_valor, 2),
            "unidades": diff_unidades,
            "unidades_pct": round(diff_unidades / linear["unidades"] * 100, 2) if linear["unidades"] else None,
        },
        "aviso": "Comparação RELATIVA de estratégias sobre a mesma trajetória. NÃO é previsão de retorno.",
    }


def trajetoria_sintetica(preco_inicial: float, periodos: int, cenario: str) -> list:
    """Gera uma trajetória simples otimista/base/pessimista (para o utilizador
    ter um ponto de partida; pode sempre carregar série própria)."""
    fatores = {
        "otimista": 1.0 + 0.9 / periodos,     # sobe ~90% no total
        "base": 1.0 + 0.2 / periodos,         # sobe ~20%
        "pessimista": 1.0 - 0.4 / periodos,   # cai ~40%
    }
    f = fatores.get(cenario, fatores["base"])
    precos = []
    p = preco_inicial
    for i in range(periodos):
        # dente de serra ligeiro para a escada ter o que morder
        onda = 1.0 + 0.12 * (-1 if i % 3 == 1 else (1 if i % 3 == 2 else 0))
        precos.append(round(p * onda, 6))
        p *= f
    return precos
