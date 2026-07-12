"""M5 — Simulador de cenários: DCA linear vs DCA + reserva."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..common import get_settings
from ..engine import scenarios

router = APIRouter(prefix="/api", tags=["cenarios"])


class CenarioIn(BaseModel):
    budget: float
    base_frac: float = 0.6              # ~60% base, ~40% reserva
    precos: Optional[list[float]] = None  # trajetória própria
    # ou gerar trajetória sintética:
    preco_inicial: Optional[float] = None
    periodos: Optional[int] = None
    cenario: Optional[str] = None        # otimista | base | pessimista


@router.post("/scenarios/comparar")
def comparar(body: CenarioIn):
    s = get_settings()
    e1, e2, e3 = float(s["escada_1"]), float(s["escada_2"]), float(s["escada_3"])

    precos = body.precos
    if not precos:
        if not (body.preco_inicial and body.periodos and body.cenario):
            raise HTTPException(400, "Fornece `precos` OU (preco_inicial, periodos, cenario).")
        precos = scenarios.trajetoria_sintetica(body.preco_inicial, body.periodos, body.cenario)

    if len(precos) < 2:
        raise HTTPException(400, "A trajetória precisa de pelo menos 2 preços.")

    resultado = scenarios.compara(precos, body.budget, body.base_frac, e1, e2, e3)
    resultado["precos"] = precos
    return resultado
