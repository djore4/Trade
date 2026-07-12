"""M3 — Lotes & fiscalidade: transações (CRUD), relógio dos 365 dias e venda FIFO."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..db import connect
from ..engine import tax
from ..common import DISCLAIMER

router = APIRouter(prefix="/api", tags=["lotes"])


class TxIn(BaseModel):
    asset_id: int
    tipo: str          # buy | sell
    data: str          # YYYY-MM-DD
    qtd: float
    preco: float
    taxas: float = 0.0


def _txs(conn, asset_id: int):
    rows = conn.execute(
        "SELECT id, tipo, data, qtd, preco, taxas FROM transactions WHERE asset_id = ? ORDER BY data, id",
        (asset_id,),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/transactions")
def list_transactions(asset_id: Optional[int] = None):
    conn = connect()
    if asset_id:
        rows = conn.execute(
            "SELECT t.*, a.simbolo FROM transactions t JOIN assets a ON a.id = t.asset_id "
            "WHERE t.asset_id = ? ORDER BY t.data, t.id", (asset_id,)).fetchall()
    else:
        rows = conn.execute(
            "SELECT t.*, a.simbolo FROM transactions t JOIN assets a ON a.id = t.asset_id "
            "ORDER BY t.data, t.id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/transactions")
def create_transaction(t: TxIn):
    if t.tipo not in ("buy", "sell"):
        raise HTTPException(400, "tipo tem de ser buy ou sell")
    conn = connect()
    with conn:
        cur = conn.execute(
            "INSERT INTO transactions (asset_id, tipo, data, qtd, preco, taxas) VALUES (?, ?, ?, ?, ?, ?)",
            (t.asset_id, t.tipo, t.data, t.qtd, t.preco, t.taxas),
        )
    conn.close()
    return {"id": cur.lastrowid}


@router.put("/transactions/{tx_id}")
def update_transaction(tx_id: int, t: TxIn):
    conn = connect()
    with conn:
        conn.execute(
            "UPDATE transactions SET asset_id=?, tipo=?, data=?, qtd=?, preco=?, taxas=? WHERE id=?",
            (t.asset_id, t.tipo, t.data, t.qtd, t.preco, t.taxas, tx_id),
        )
    conn.close()
    return {"ok": True}


@router.delete("/transactions/{tx_id}")
def delete_transaction(tx_id: int):
    conn = connect()
    with conn:
        conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
    conn.close()
    return {"ok": True}


@router.get("/lots/{asset_id}")
def lots(asset_id: int):
    conn = connect()
    a = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    txs = _txs(conn, asset_id)
    conn.close()
    if not a:
        raise HTTPException(404, "ativo não encontrado")
    estado = tax.estado_lotes(txs)
    return {
        "asset_id": asset_id,
        "simbolo": a["simbolo"],
        "quadrante": a["quadrante"],
        **estado,
        "disclaimer": DISCLAIMER,
        "nota_derivados": "Derivados (perps) NÃO contam para os 365 dias e são "
                          "tributados à parte (28% ou pior; trading frequente pode "
                          "cair em categoria B).",
        "nota_dac8": "A Bybit reporta à AT (DAC8). Os teus dados são reportados.",
    }


class VendaIn(BaseModel):
    qtd: float
    preco: float


@router.post("/lots/{asset_id}/simular-venda")
def simular_venda(asset_id: int, v: VendaIn):
    conn = connect()
    txs = _txs(conn, asset_id)
    conn.close()
    r = tax.simula_venda(txs, v.qtd, v.preco)
    if "erro" in r:
        raise HTTPException(400, r["erro"])
    return r
