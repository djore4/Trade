"""Contas e ativos — CRUD. A lista de ativos é editável (não fixa)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..db import connect

router = APIRouter(prefix="/api", tags=["contas"])


class AccountIn(BaseModel):
    nome: str
    tipo: str
    owner: str = "eu"


class AssetIn(BaseModel):
    simbolo: str
    nome: Optional[str] = None
    moeda: str = "USD"
    quadrante: Optional[str] = None
    account_id: int
    owner: str = "eu"


@router.get("/accounts")
def list_accounts():
    conn = connect()
    rows = conn.execute("SELECT * FROM accounts ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/accounts")
def create_account(a: AccountIn):
    conn = connect()
    with conn:
        cur = conn.execute(
            "INSERT INTO accounts (nome, tipo, owner) VALUES (?, ?, ?)",
            (a.nome, a.tipo, a.owner),
        )
    conn.close()
    return {"id": cur.lastrowid}


@router.get("/assets")
def list_assets(incluir_arquivados: bool = False):
    conn = connect()
    q = "SELECT a.*, c.nome AS conta_nome, c.tipo AS conta_tipo FROM assets a " \
        "LEFT JOIN accounts c ON c.id = a.account_id"
    if not incluir_arquivados:
        q += " WHERE a.ativo = 1"
    q += " ORDER BY a.id"
    rows = conn.execute(q).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/assets")
def create_asset(a: AssetIn):
    conn = connect()
    with conn:
        cur = conn.execute(
            """INSERT INTO assets (simbolo, nome, moeda, quadrante, account_id, owner)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (a.simbolo.upper(), a.nome, a.moeda, a.quadrante, a.account_id, a.owner),
        )
        conn.execute("INSERT OR IGNORE INTO reserve_budget (asset_id) VALUES (?)", (cur.lastrowid,))
    conn.close()
    return {"id": cur.lastrowid}


@router.put("/assets/{asset_id}")
def update_asset(asset_id: int, a: AssetIn):
    conn = connect()
    with conn:
        conn.execute(
            """UPDATE assets SET simbolo=?, nome=?, moeda=?, quadrante=?, account_id=?, owner=?
               WHERE id=?""",
            (a.simbolo.upper(), a.nome, a.moeda, a.quadrante, a.account_id, a.owner, asset_id),
        )
    conn.close()
    return {"ok": True}


@router.delete("/assets/{asset_id}")
def archive_asset(asset_id: int):
    """Arquiva (não apaga) para preservar o histórico de transações."""
    conn = connect()
    with conn:
        conn.execute("UPDATE assets SET ativo = 0 WHERE id = ?", (asset_id,))
    conn.close()
    return {"ok": True}
