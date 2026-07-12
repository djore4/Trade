"""Motor de estratégia: escada de quedas + orçamento de reserva + kill-switch.

Regras (§2.2):
  queda >= escada_3 -> 3x
  queda >= escada_2 -> 2x
  queda >= escada_1 -> 1x
  abaixo de escada_1 -> aguarda (0x)

Travões obrigatórios:
  - a sugestão nunca excede a reserva restante (total - gasto);
  - respeita o limite de acionamentos (max_triggers);
  - kill-switch pausa as sugestões do ativo e explica porquê.
"""
from typing import Optional


def multiplicador(drawdown_pct: float, e1: float, e2: float, e3: float) -> int:
    """drawdown_pct em % positiva (ex.: 20 = -20%)."""
    if drawdown_pct >= e3:
        return 3
    if drawdown_pct >= e2:
        return 2
    if drawdown_pct >= e1:
        return 1
    return 0


def avalia(
    preco_atual: Optional[float],
    high: Optional[float],
    base_amount: float,
    reserve_total: float,
    reserve_gasto: float,
    max_triggers: int,
    triggers_used: int,
    killswitch: bool,
    killswitch_motivo: Optional[str],
    e1: float,
    e2: float,
    e3: float,
) -> dict:
    """Devolve a avaliação da escada para um ativo.

    Campos: drawdown_pct, multiplo, sugestao (€ limitado), reserva_restante,
    estado ('aguarda'|'armado'|'pausado'|'sem_dados'|'sem_reserva'|'limite'),
    motivo (texto explicativo).
    """
    reserva_restante = max(0.0, reserve_total - reserve_gasto)

    if killswitch:
        return {
            "drawdown_pct": None,
            "multiplo": 0,
            "sugestao": 0.0,
            "reserva_restante": reserva_restante,
            "estado": "pausado",
            "motivo": f"Kill-switch ligado: {killswitch_motivo or 'tese em revisão — sem reforços'}",
        }

    if not preco_atual or not high or high <= 0:
        return {
            "drawdown_pct": None,
            "multiplo": 0,
            "sugestao": 0.0,
            "reserva_restante": reserva_restante,
            "estado": "sem_dados",
            "motivo": "Sem preço atual ou máximo da janela — atualiza os preços ou introduz manualmente.",
        }

    drawdown = max(0.0, (high - preco_atual) / high * 100.0)
    mult = multiplicador(drawdown, e1, e2, e3)

    if mult == 0:
        return {
            "drawdown_pct": round(drawdown, 2),
            "multiplo": 0,
            "sugestao": 0.0,
            "reserva_restante": reserva_restante,
            "estado": "aguarda",
            "motivo": f"Queda {drawdown:.1f}% < {e1:.0f}% — só entra a compra base do calendário.",
        }

    if triggers_used >= max_triggers:
        return {
            "drawdown_pct": round(drawdown, 2),
            "multiplo": mult,
            "sugestao": 0.0,
            "reserva_restante": reserva_restante,
            "estado": "limite",
            "motivo": f"Limite de acionamentos atingido ({triggers_used}/{max_triggers}).",
        }

    if reserva_restante <= 0:
        return {
            "drawdown_pct": round(drawdown, 2),
            "multiplo": mult,
            "sugestao": 0.0,
            "reserva_restante": 0.0,
            "estado": "sem_reserva",
            "motivo": "Reserva esgotada — guarda munição para o fundo real.",
        }

    bruto = mult * base_amount
    sugestao = min(bruto, reserva_restante)
    limitado = sugestao < bruto
    motivo = f"Queda {drawdown:.1f}% arma {mult}× a base ({base_amount:.0f}€)."
    if limitado:
        motivo += f" Limitado pela reserva restante ({reserva_restante:.0f}€)."
    return {
        "drawdown_pct": round(drawdown, 2),
        "multiplo": mult,
        "sugestao": round(sugestao, 2),
        "reserva_restante": round(reserva_restante, 2),
        "estado": "armado",
        "motivo": motivo,
    }
