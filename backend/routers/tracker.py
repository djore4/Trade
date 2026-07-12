"""M2 — Tracker spot + MSTR, com escada de quedas, reserva e sinal mNAV."""
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from ..db import connect
from ..common import get_settings, eur_usd, posicao_ativo
from ..engine import ladder, mnav

router = APIRouter(prefix="/api", tags=["tracker"])


def _reserve(conn, asset_id: int) -> dict:
    row = conn.execute("SELECT * FROM reserve_budget WHERE asset_id = ?", (asset_id,)).fetchone()
    if not row:
        conn.execute("INSERT OR IGNORE INTO reserve_budget (asset_id) VALUES (?)", (asset_id,))
        row = conn.execute("SELECT * FROM reserve_budget WHERE asset_id = ?", (asset_id,)).fetchone()
    return dict(row)


@router.get("/tracker")
def tracker():
    s = get_settings()
    fx = eur_usd(s)
    e1, e2, e3 = float(s["escada_1"]), float(s["escada_2"]), float(s["escada_3"])
    conn = connect()
    assets = conn.execute("SELECT * FROM assets WHERE ativo = 1 ORDER BY id").fetchall()

    linhas = []
    for a in assets:
        pos = posicao_ativo(conn, a["id"])
        rb = _reserve(conn, a["id"])
        pc = conn.execute("SELECT * FROM prices_cache WHERE simbolo = ?", (a["simbolo"],)).fetchone()
        preco = pc["preco"] if pc else None
        high = pc["high_60_90d"] if pc else None

        moeda = a["moeda"]
        preco_eur = (preco * fx) if (preco is not None and moeda == "USD") else preco
        custo_medio_eur = None
        if pos["custo_medio"] is not None:
            custo_medio_eur = pos["custo_medio"] * fx if moeda == "USD" else pos["custo_medio"]

        valor_eur = (pos["qtd"] * preco_eur) if (preco_eur is not None) else None
        custo_eur = pos["custo_total"] * fx if moeda == "USD" else pos["custo_total"]
        pnl_eur = (valor_eur - custo_eur) if valor_eur is not None else None
        pnl_pct = (pnl_eur / custo_eur * 100) if (pnl_eur is not None and custo_eur > 0) else None

        av = ladder.avalia(
            preco, high, rb["base_amount"], rb["total"], rb["gasto"],
            rb["max_triggers"], rb["triggers_used"], bool(rb["killswitch"]),
            rb["killswitch_motivo"], e1, e2, e3,
        )

        linha = {
            "asset_id": a["id"],
            "simbolo": a["simbolo"],
            "nome": a["nome"],
            "quadrante": a["quadrante"],
            "owner": a["owner"],
            "moeda": moeda,
            "qtd": pos["qtd"],
            "custo_medio": pos["custo_medio"],
            "custo_medio_eur": custo_medio_eur,
            "preco": preco,
            "preco_eur": preco_eur,
            "high": high,
            "valor_eur": valor_eur,
            "pnl_eur": pnl_eur,
            "pnl_pct": pnl_pct,
            "escada": av,
            "reserva": {
                "base_amount": rb["base_amount"],
                "total": rb["total"],
                "gasto": rb["gasto"],
                "restante": max(0.0, rb["total"] - rb["gasto"]),
                "max_triggers": rb["max_triggers"],
                "triggers_used": rb["triggers_used"],
                "killswitch": bool(rb["killswitch"]),
                "killswitch_motivo": rb["killswitch_motivo"],
            },
            "preco_fonte": pc["fonte"] if pc else None,
            "preco_ts": pc["timestamp"] if pc else None,
        }
        if a["simbolo"] == "MSTR":
            linha["mnav"] = _mnav_signal(conn, s)
        linhas.append(linha)

    conn.close()
    return {
        "eur_usd": fx,
        "ativos": linhas,
        "aviso_custo_medio": "O P&L por custo médio mostra 'como estás', NÃO serve para "
                             "decidir vendas — para isso usa a vista de Lotes (fiscal).",
    }


def _mnav_signal(conn, s) -> dict:
    mi = conn.execute("SELECT * FROM mstr_inputs ORDER BY data DESC, id DESC LIMIT 1").fetchone()
    pc_mstr = conn.execute("SELECT * FROM prices_cache WHERE simbolo = 'MSTR'").fetchone()
    pc_btc = conn.execute("SELECT * FROM prices_cache WHERE simbolo = 'BTC'").fetchone()
    return mnav.calcula(
        pc_mstr["preco"] if pc_mstr else None,
        mi["shares_outstanding"] if mi else None,
        mi["btc_treasury"] if mi else None,
        pc_btc["preco"] if pc_btc else None,
        float(s["mnav_favoravel"]), float(s["mnav_travar"]),
    ) | {"data_inputs": mi["data"] if mi else None}


# --- gestão da reserva / kill-switch por ativo ------------------------
class ReserveIn(BaseModel):
    base_amount: Optional[float] = None
    total: Optional[float] = None
    gasto: Optional[float] = None
    max_triggers: Optional[int] = None
    triggers_used: Optional[int] = None
    killswitch: Optional[bool] = None
    killswitch_motivo: Optional[str] = None


@router.put("/reserve/{asset_id}")
def update_reserve(asset_id: int, r: ReserveIn):
    conn = connect()
    with conn:
        _reserve(conn, asset_id)
        campos = {k: v for k, v in r.model_dump().items() if v is not None}
        if "killswitch" in campos:
            campos["killswitch"] = 1 if campos["killswitch"] else 0
        if campos:
            sets = ", ".join(f"{k} = ?" for k in campos)
            conn.execute(f"UPDATE reserve_budget SET {sets} WHERE asset_id = ?",
                         (*campos.values(), asset_id))
    conn.close()
    return {"ok": True}


class RegistaReforcoIn(BaseModel):
    montante: float


@router.post("/reserve/{asset_id}/regista-reforco")
def regista_reforco(asset_id: int, body: RegistaReforcoIn):
    """Regista que um reforço da reserva foi executado: soma ao gasto e ao contador."""
    conn = connect()
    with conn:
        rb = _reserve(conn, asset_id)
        novo_gasto = min(rb["total"], rb["gasto"] + max(0.0, body.montante))
        conn.execute(
            "UPDATE reserve_budget SET gasto = ?, triggers_used = triggers_used + 1 WHERE asset_id = ?",
            (novo_gasto, asset_id),
        )
    conn.close()
    return {"ok": True, "gasto": novo_gasto}
