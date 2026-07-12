"""M4 — Inversos (simulador): posições alavancadas, liquidação, funding, P&L."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..db import connect
from ..common import get_settings, eur_usd
from ..engine import perp

router = APIRouter(prefix="/api", tags=["perps"])


class PerpIn(BaseModel):
    ativo: str
    direcao: str            # long | short
    contrato: str           # linear | inverse
    entrada: float
    qtd: float = 0.0
    margem: Optional[float] = None
    alavancagem: float = 1.0
    funding_acum: float = 0.0
    mmr: float = 0.005
    mark: Optional[float] = None
    estado: str = "aberta"
    owner: str = "eu"


def _avalia_row(row, fx) -> dict:
    r = perp.avalia(
        row["direcao"], row["contrato"], row["entrada"], row["qtd"],
        row["alavancagem"], row["funding_acum"], row["mark"], row["mmr"], fx,
    )
    return {**dict(row), **r}


@router.get("/perps")
def list_perps():
    s = get_settings()
    fx = eur_usd(s)
    conn = connect()
    rows = conn.execute("SELECT * FROM perp_positions ORDER BY id").fetchall()
    conn.close()
    return {
        "eur_usd": fx,
        "posicoes": [_avalia_row(r, fx) for r in rows],
        "aviso": "P&L de derivados é SEPARADO do spot. Liquidação e funding são "
                 "APROXIMAÇÕES (margem isolada; excluem taxas e margem de manutenção "
                 "real — na prática liquida antes).",
    }


@router.post("/perps")
def create_perp(p: PerpIn):
    conn = connect()
    with conn:
        cur = conn.execute(
            """INSERT INTO perp_positions
               (ativo, direcao, contrato, entrada, qtd, margem, alavancagem,
                funding_acum, mmr, mark, estado, owner)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (p.ativo.upper(), p.direcao, p.contrato, p.entrada, p.qtd, p.margem,
             p.alavancagem, p.funding_acum, p.mmr, p.mark, p.estado, p.owner),
        )
    conn.close()
    return {"id": cur.lastrowid}


@router.put("/perps/{perp_id}")
def update_perp(perp_id: int, p: PerpIn):
    conn = connect()
    with conn:
        conn.execute(
            """UPDATE perp_positions SET ativo=?, direcao=?, contrato=?, entrada=?, qtd=?,
               margem=?, alavancagem=?, funding_acum=?, mmr=?, mark=?, estado=?, owner=? WHERE id=?""",
            (p.ativo.upper(), p.direcao, p.contrato, p.entrada, p.qtd, p.margem,
             p.alavancagem, p.funding_acum, p.mmr, p.mark, p.estado, p.owner, perp_id),
        )
    conn.close()
    return {"ok": True}


@router.delete("/perps/{perp_id}")
def delete_perp(perp_id: int):
    conn = connect()
    with conn:
        conn.execute("DELETE FROM perp_positions WHERE id = ?", (perp_id,))
    conn.close()
    return {"ok": True}


class SimIn(BaseModel):
    precos_saida: list[float]


@router.post("/perps/{perp_id}/simular")
def simular(perp_id: int, body: SimIn):
    s = get_settings()
    fx = eur_usd(s)
    conn = connect()
    row = conn.execute("SELECT * FROM perp_positions WHERE id = ?", (perp_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "posição não encontrada")
    linhas = perp.simula_saida(
        row["direcao"], row["contrato"], row["entrada"], row["qtd"],
        row["alavancagem"], row["funding_acum"], row["mmr"], fx, body.precos_saida,
    )
    return {"simulacao": linhas, "eur_usd": fx}
