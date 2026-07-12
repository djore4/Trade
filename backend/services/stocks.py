"""Cotações de ações (MSTR) e preço BTC — fontes públicas, degradação manual (§6).

As POSIÇÕES MSTR entram à mão (Trading 212 não tem API de retalho fiável).
Aqui só tentamos o PREÇO de mercado da MSTR e do BTC para o cálculo do mNAV.
"""
from datetime import datetime, timezone

import httpx

TIMEOUT = 8.0


def _yahoo_quote(simbolo: str) -> dict:
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": "Mozilla/5.0"}) as c:
        r = c.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{simbolo}",
            params={"range": "1d", "interval": "1d"},
        )
        r.raise_for_status()
        j = r.json()
        res = j["chart"]["result"][0]
        preco = res["meta"]["regularMarketPrice"]
        return {"preco": float(preco)}


def preco_mstr() -> dict:
    try:
        q = _yahoo_quote("MSTR")
        return {"ok": True, "simbolo": "MSTR", "preco": q["preco"], "fonte": "yahoo",
                "timestamp": datetime.now(timezone.utc).isoformat()}
    except Exception as e:
        return {"ok": False, "erro": f"Cotação MSTR indisponível ({type(e).__name__}). Introduz manualmente."}


def preco_btc() -> dict:
    try:
        q = _yahoo_quote("BTC-USD")
        return {"ok": True, "simbolo": "BTC", "preco": q["preco"], "fonte": "yahoo",
                "timestamp": datetime.now(timezone.utc).isoformat()}
    except Exception as e:
        return {"ok": False, "erro": f"Preço BTC indisponível ({type(e).__name__}). Introduz manualmente."}
