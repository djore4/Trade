"""M7 — Definições + refresh de preços + estado de integrações.

Nunca mostra chaves de API — apenas o estado (ligada / não ligada / read-only).
"""
from fastapi import APIRouter
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional

from ..db import connect
from ..common import get_settings, set_setting
from ..services import bybit, fx as fx_service, stocks
from .. import config

router = APIRouter(prefix="/api", tags=["definicoes"])


@router.get("/settings")
def read_settings():
    return get_settings()


class SettingsIn(BaseModel):
    valores: dict


@router.put("/settings")
def write_settings(body: SettingsIn):
    for k, v in body.valores.items():
        set_setting(k, v)
    return {"ok": True}


# --- inputs manuais do mNAV -------------------------------------------
class MstrInputs(BaseModel):
    btc_treasury: float
    shares_outstanding: float
    data: Optional[str] = None


@router.get("/mstr-inputs")
def get_mstr_inputs():
    conn = connect()
    row = conn.execute("SELECT * FROM mstr_inputs ORDER BY data DESC, id DESC LIMIT 1").fetchone()
    conn.close()
    return dict(row) if row else {}


@router.post("/mstr-inputs")
def set_mstr_inputs(m: MstrInputs):
    conn = connect()
    with conn:
        conn.execute(
            "INSERT INTO mstr_inputs (btc_treasury, shares_outstanding, data) VALUES (?, ?, ?)",
            (m.btc_treasury, m.shares_outstanding, m.data or datetime.now().date().isoformat()),
        )
    conn.close()
    return {"ok": True}


# --- estado das integrações -------------------------------------------
@router.get("/integrations/status")
def integrations_status():
    configured = config.bybit_configured()
    status = {
        "bybit": {"ligada": configured, "readonly": None, "aviso": None},
        "cambio": {"ligada": True, "fonte": "frankfurter/BCE (público)"},
        "mstr": {"ligada": True, "fonte": "yahoo (público)"},
        "ppr": {"ligada": False, "fonte": "manual (sem fonte pública fiável)"},
    }
    if configured:
        perm = bybit.verifica_permissoes()
        if perm.get("ok"):
            status["bybit"]["readonly"] = perm.get("readonly")
            status["bybit"]["aviso"] = perm.get("aviso")
        else:
            status["bybit"]["aviso"] = perm.get("erro")
    return status


# --- refresh de preços (manual, por botão) ----------------------------
def _guarda_preco(conn, simbolo, preco, high, fonte):
    conn.execute(
        """INSERT INTO prices_cache (simbolo, preco, high_60_90d, timestamp, fonte)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(simbolo) DO UPDATE SET
             preco=excluded.preco,
             high_60_90d=COALESCE(excluded.high_60_90d, prices_cache.high_60_90d),
             timestamp=excluded.timestamp, fonte=excluded.fonte""",
        (simbolo.upper(), preco, high, datetime.now(timezone.utc).isoformat(), fonte),
    )


@router.post("/refresh-precos")
def refresh_precos():
    """Atualiza preços cripto (Bybit público), câmbio, MSTR e BTC. Degrada por fonte."""
    s = get_settings()
    janela = int(s.get("janela_topo_dias", "75"))
    resultados = {"cripto": [], "cambio": None, "mstr": None, "btc": None}
    conn = connect()

    # cripto spot (todos os ativos cripto listados, exceto MSTR)
    assets = conn.execute(
        "SELECT DISTINCT simbolo, moeda, quadrante FROM assets WHERE ativo = 1"
    ).fetchall()
    with conn:
        for a in assets:
            if a["simbolo"] in ("MSTR",) or a["quadrante"] == "PPR":
                continue
            r = bybit.preco_e_topo(a["simbolo"], janela)
            if r.get("ok"):
                _guarda_preco(conn, a["simbolo"], r["preco"], r["high_60_90d"], r["fonte"])
                resultados["cripto"].append({"simbolo": a["simbolo"], "ok": True, "preco": r["preco"]})
            else:
                resultados["cripto"].append({"simbolo": a["simbolo"], "ok": False, "erro": r.get("erro")})

        # câmbio
        fxr = fx_service.usd_para_eur()
        if fxr.get("ok"):
            set_setting("eur_usd", fxr["eur_usd"])
            set_setting("eur_usd_fonte", fxr["fonte"])
            resultados["cambio"] = {"ok": True, "eur_usd": fxr["eur_usd"]}
        else:
            resultados["cambio"] = {"ok": False, "erro": fxr.get("erro")}

        # MSTR + BTC (para o mNAV)
        m = stocks.preco_mstr()
        if m.get("ok"):
            _guarda_preco(conn, "MSTR", m["preco"], None, m["fonte"])
            resultados["mstr"] = {"ok": True, "preco": m["preco"]}
        else:
            resultados["mstr"] = {"ok": False, "erro": m.get("erro")}

        b = stocks.preco_btc()
        if b.get("ok"):
            _guarda_preco(conn, "BTC", b["preco"], None, b["fonte"])
            resultados["btc"] = {"ok": True, "preco": b["preco"]}
        else:
            resultados["btc"] = {"ok": False, "erro": b.get("erro")}

    conn.close()
    resultados["timestamp"] = datetime.now(timezone.utc).isoformat()
    return resultados


# --- override manual de um preço --------------------------------------
class PrecoManual(BaseModel):
    simbolo: str
    preco: Optional[float] = None
    high_60_90d: Optional[float] = None


@router.post("/preco-manual")
def preco_manual(p: PrecoManual):
    conn = connect()
    with conn:
        existing = conn.execute("SELECT * FROM prices_cache WHERE simbolo = ?", (p.simbolo.upper(),)).fetchone()
        preco = p.preco if p.preco is not None else (existing["preco"] if existing else None)
        high = p.high_60_90d if p.high_60_90d is not None else (existing["high_60_90d"] if existing else None)
        _guarda_preco(conn, p.simbolo, preco, high, "manual")
    conn.close()
    return {"ok": True}
