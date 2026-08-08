"""Cliente REST Bybit v5 (público). Única camada com rede.

Requer `requests` (ver scanner/requirements.txt). Importado de forma tardia para
que as funções puras e os testes corram sem dependências.
"""
from __future__ import annotations

import re
import time
from typing import List

from .structure import Klines

BASE = "https://api.bybit.com"


def _get(path: str, params: dict, retries: int = 4) -> dict:
    import requests  # import tardio: só quando se usa a rede
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(f"{BASE}{path}", params=params, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Bybit GET {path} falhou após {retries} tentativas: {last}")


def coin_of(symbol: str) -> str:
    return re.sub(r"USDT$", "", symbol)


def fetch_universe(min_turnover: float, top: int | None = None) -> tuple[list[dict], int]:
    """Perps USDT ordenados por turnover. Devolve (lista_filtrada, universo_total)."""
    d = _get("/v5/market/tickers", {"category": "linear"})
    rows = []
    for t in d.get("result", {}).get("list", []):
        sym = t["symbol"]
        if not sym.endswith("USDT") or re.search(r"[0-9]", coin_of(sym)):
            continue
        try:
            price = float(t["lastPrice"])
            turnover = float(t.get("turnover24h") or 0.0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        rows.append({"symbol": sym, "coin": coin_of(sym), "price": price, "turnover": turnover})
    rows.sort(key=lambda x: x["turnover"], reverse=True)
    full = len(rows)
    filt = [r for r in rows if r["turnover"] >= min_turnover]
    if top:
        filt = filt[:top]
    return filt, full


def fetch_kline(symbol: str, interval: str, limit: int) -> Klines:
    """Klines cronológicas (antigo → recente)."""
    d = _get("/v5/market/kline",
             {"category": "linear", "symbol": symbol, "interval": interval, "limit": limit})
    lst = list(reversed(d.get("result", {}).get("list", [])))
    return Klines(
        o=[float(x[1]) for x in lst],
        h=[float(x[2]) for x in lst],
        l=[float(x[3]) for x in lst],
        c=[float(x[4]) for x in lst],
        v=[float(x[5]) for x in lst],
    )
