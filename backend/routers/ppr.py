"""M6 — PPR: titularidade distinta (Patrícia). Valores manuais, cotação tentada."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import date
from typing import Optional

from ..db import connect
from ..services import ppr as ppr_service
from ..common import DISCLAIMER

router = APIRouter(prefix="/api", tags=["ppr"])


class PprIn(BaseModel):
    nome: str
    owner: str = "patricia"
    investido: float = 0.0
    valor: float = 0.0
    data_atualizacao: Optional[str] = None


@router.get("/ppr")
def list_ppr():
    conn = connect()
    rows = conn.execute("SELECT * FROM ppr ORDER BY id").fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["pnl"] = round(d["valor"] - d["investido"], 2)
        d["pnl_pct"] = round((d["valor"] - d["investido"]) / d["investido"] * 100, 2) if d["investido"] else None
        out.append(d)
    return {
        "pprs": out,
        "nota_titularidade": "PPR de titularidade DISTINTA (Patrícia). Não somar a "
                             "mais-valia/dedução dela com a tua.",
        "nota_fiscal": "PPR tem fiscalidade própria (dedução à entrada com tetos; "
                       "saída ~8,6% após 8 anos). Estimativa — não substitui contabilista.",
        "disclaimer": DISCLAIMER,
    }


@router.post("/ppr")
def create_ppr(p: PprIn):
    conn = connect()
    with conn:
        cur = conn.execute(
            "INSERT INTO ppr (nome, owner, investido, valor, data_atualizacao) VALUES (?, ?, ?, ?, ?)",
            (p.nome, p.owner, p.investido, p.valor, p.data_atualizacao),
        )
    conn.close()
    return {"id": cur.lastrowid}


@router.put("/ppr/{ppr_id}")
def update_ppr(ppr_id: int, p: PprIn):
    conn = connect()
    with conn:
        conn.execute(
            "UPDATE ppr SET nome=?, owner=?, investido=?, valor=?, data_atualizacao=? WHERE id=?",
            (p.nome, p.owner, p.investido, p.valor, p.data_atualizacao or date.today().isoformat(), ppr_id),
        )
    conn.close()
    return {"ok": True}


@router.delete("/ppr/{ppr_id}")
def delete_ppr(ppr_id: int):
    conn = connect()
    with conn:
        conn.execute("DELETE FROM ppr WHERE id = ?", (ppr_id,))
    conn.close()
    return {"ok": True}


@router.post("/ppr/{ppr_id}/atualizar-cotacao")
def atualizar_cotacao(ppr_id: int):
    """Tenta obter a cotação pública. Degrada para manual — não inventa valores."""
    r = ppr_service.cotacao()
    return r  # {ok:False, manual:True, erro:...} — a UI mantém entrada manual
