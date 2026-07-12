"""Bybit — dados públicos (preços + máximo 60–90d) e privados READ-ONLY.

READ-ONLY é inegociável (§7): nunca coloca ordens, nunca move fundos, nunca usa
endpoints de trade. Só endpoints de leitura. Se as chaves tiverem permissões de
trade/escrita, a app avisa e recusa usá-las.

Toda a rede degrada com elegância: qualquer falha devolve {ok: False, erro},
nunca lança exceção para cima.
"""
import hashlib
import hmac
import time
from datetime import datetime, timezone

import httpx

from .. import config

BASE = "https://api.bybit.com"
BASE_TESTNET = "https://api-testnet.bybit.com"
TIMEOUT = 8.0


def _base_url() -> str:
    return BASE_TESTNET if config.bybit_env() == "testnet" else BASE


def preco_e_topo(simbolo: str, dias: int = 75) -> dict:
    """Preço spot atual + máximo dos últimos `dias` (público, sem chaves).

    Usa o par SÍMBOLO/USDT. Máximo obtido de klines diárias.
    """
    par = f"{simbolo.upper()}USDT"
    try:
        with httpx.Client(timeout=TIMEOUT) as c:
            # preço atual (spot ticker)
            t = c.get(f"{_base_url()}/v5/market/tickers", params={"category": "spot", "symbol": par})
            t.raise_for_status()
            tj = t.json()
            if tj.get("retCode") != 0 or not tj["result"]["list"]:
                return {"ok": False, "erro": f"Sem ticker para {par}."}
            preco = float(tj["result"]["list"][0]["lastPrice"])

            # klines diárias para o máximo da janela
            k = c.get(
                f"{_base_url()}/v5/market/kline",
                params={"category": "spot", "symbol": par, "interval": "D", "limit": min(dias, 200)},
            )
            k.raise_for_status()
            kj = k.json()
            highs = [float(row[2]) for row in kj["result"]["list"]] if kj.get("retCode") == 0 else []
            high = max(highs) if highs else None

        return {
            "ok": True,
            "simbolo": simbolo.upper(),
            "preco": preco,
            "high_60_90d": high,
            "fonte": "bybit-public",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:  # degradação elegante
        return {"ok": False, "erro": f"Bybit indisponível ({type(e).__name__}). Usa entrada manual."}


def _assinado(endpoint: str, params: dict) -> dict:
    """GET privado assinado (apenas leitura). Nunca chama endpoints de trade."""
    key, secret = config.bybit_keys()
    if not key or not secret:
        return {"ok": False, "erro": "Sem chaves Bybit configuradas — modo manual."}
    ts = str(int(time.time() * 1000))
    recv = "5000"
    query = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    payload = ts + key + recv + query
    sign = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    headers = {
        "X-BAPI-API-KEY": key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
    }
    try:
        with httpx.Client(timeout=TIMEOUT) as c:
            r = c.get(f"{_base_url()}{endpoint}", params=params, headers=headers)
            r.raise_for_status()
            j = r.json()
            if j.get("retCode") != 0:
                return {"ok": False, "erro": j.get("retMsg", "erro Bybit")}
            return {"ok": True, "result": j["result"]}
    except Exception as e:
        return {"ok": False, "erro": f"Bybit privado indisponível ({type(e).__name__})."}


def verifica_permissoes() -> dict:
    """Confirma que a chave é read-only. Se tiver permissões de trade, avisa."""
    r = _assinado("/v5/user/query-api", {})
    if not r.get("ok"):
        return {"ok": False, "erro": r.get("erro")}
    info = r["result"]
    permissoes = info.get("permissions", {})
    # Bybit devolve permissões por grupo. Trade/derivativos = escrita.
    escrita = []
    for grupo, perms in permissoes.items():
        if perms and grupo not in ("Wallet", "Options") and any(perms):
            # marca grupos que costumam implicar ordens
            if grupo in ("Spot", "Derivatives", "Order", "Trade", "Exchange"):
                escrita.append(grupo)
    return {
        "ok": True,
        "readonly": len(escrita) == 0,
        "grupos_escrita": escrita,
        "aviso": None if not escrita else
                 f"A chave tem permissões potencialmente de escrita: {escrita}. "
                 f"Cria uma chave SÓ DE LEITURA.",
    }


def posicoes() -> dict:
    """Posições de derivados (leitura). Categoria linear por omissão."""
    r = _assinado("/v5/position/list", {"category": "linear", "settleCoin": "USDT"})
    return r


def funding_recente(simbolo: str, category: str = "linear") -> dict:
    """Histórico de funding (leitura)."""
    par = f"{simbolo.upper()}USDT"
    return _assinado("/v5/account/transaction-log", {"category": category, "symbol": par, "type": "SETTLEMENT"})
