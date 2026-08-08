"""Cliente REST Bybit v5 (público). Única camada com rede.

Requer `requests` (ver scanner/requirements.txt). Importado de forma tardia para
que as funções puras e os testes corram sem dependências.
"""
from __future__ import annotations

import re
import time
from typing import Iterable, List, Tuple

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


def fetch_universe(min_turnover: float, top: int | None = None,
                   exclude: Iterable[str] = ()) -> tuple[list[dict], int, list[str]]:
    """Perps USDT ordenados por turnover, SÓ cripto.

    `exclude`: baseCoins a retirar (ações/metais tokenizados — secção 2 do
    framework). Devolve (lista_filtrada, universo_total, excluidos).
    """
    excl = {e.upper() for e in exclude}
    d = _get("/v5/market/tickers", {"category": "linear"})
    rows, removed = [], []
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
        base = coin_of(sym)
        if base.upper() in excl:
            if turnover >= min_turnover:
                removed.append(sym)
            continue
        rows.append({"symbol": sym, "coin": base, "price": price, "turnover": turnover})
    rows.sort(key=lambda x: x["turnover"], reverse=True)
    full = len(rows)
    filt = [r for r in rows if r["turnover"] >= min_turnover]
    if top:
        filt = filt[:top]
    return filt, full, removed


def _rows_to_klines(rows_newest_first: List[list]) -> Klines:
    lst = list(reversed(rows_newest_first))            # cronológico
    return Klines(
        o=[float(x[1]) for x in lst],
        h=[float(x[2]) for x in lst],
        l=[float(x[3]) for x in lst],
        c=[float(x[4]) for x in lst],
        v=[float(x[5]) for x in lst],
        t=[float(x[0]) for x in lst],
    )


def fetch_kline(symbol: str, interval: str, limit: int) -> Klines:
    """Klines cronológicas (antigo → recente), 1 pedido (máx. 1000 barras)."""
    d = _get("/v5/market/kline",
             {"category": "linear", "symbol": symbol, "interval": interval,
              "limit": min(limit, 1000)})
    return _rows_to_klines(d.get("result", {}).get("list", []))


def fetch_kline_paged(symbol: str, interval: str, bars: int) -> Klines:
    """Klines cronológicas com paginação para trás — permite ≥6 meses de história.

    A Bybit lima cada pedido a 1000 barras; pagina-se com `end` = timestamp da
    barra mais antiga − 1 até juntar `bars` barras (ou acabar a história).
    """
    rows: List[list] = []
    end: int | None = None
    while len(rows) < bars:
        params = {"category": "linear", "symbol": symbol, "interval": interval, "limit": 1000}
        if end is not None:
            params["end"] = end
        d = _get("/v5/market/kline", params)
        lst = d.get("result", {}).get("list", [])       # mais recente → mais antigo
        if not lst:
            break
        rows.extend(lst)
        oldest = int(lst[-1][0])
        end = oldest - 1
        if len(lst) < 1000:
            break                                       # história esgotada
        time.sleep(0.06)                                # cortesia com o rate limit
    return _rows_to_klines(rows[:bars])


def fetch_funding_paged(symbol: str, since_ms: float) -> Tuple[List[int], List[float]]:
    """Histórico de funding até `since_ms`, paginado (200/pedido, períodos de 8h).

    Devolve (timestamps_ms, rates) cronológicos, para z-score point-in-time.
    """
    out: List[dict] = []
    end: int | None = None
    while True:
        params = {"category": "linear", "symbol": symbol, "limit": 200}
        if end is not None:
            params["endTime"] = end
        d = _get("/v5/market/funding/history", params)
        lst = d.get("result", {}).get("list", [])
        if not lst:
            break
        out.extend(lst)
        oldest = int(lst[-1]["fundingRateTimestamp"])
        if oldest <= since_ms or len(lst) < 200:
            break
        end = oldest - 1
        time.sleep(0.06)
    pairs = sorted((int(x["fundingRateTimestamp"]), float(x["fundingRate"])) for x in out)
    return [p[0] for p in pairs], [p[1] for p in pairs]


def fetch_oi_paged(symbol: str, interval: str, bars: int) -> Tuple[List[int], List[float]]:
    """Open interest histórico, paginado. Devolve (timestamps_ms, valores) cronológicos.

    `interval` aceita 5min/15min/30min/1h/4h/1d (mapeado a partir do TF de klines).
    """
    tf_map = {"5": "5min", "15": "15min", "30": "30min", "60": "1h",
              "240": "4h", "D": "1d"}
    iv = tf_map.get(interval, "4h")
    rows: List[dict] = []
    cursor = None
    while len(rows) < bars:
        params = {"category": "linear", "symbol": symbol,
                  "intervalTime": iv, "limit": 200}
        if cursor:
            params["cursor"] = cursor
        d = _get("/v5/market/open-interest", params)
        res = d.get("result", {})
        lst = res.get("list", [])
        if not lst:
            break
        rows.extend(lst)
        cursor = res.get("nextPageCursor")
        if not cursor:
            break
        time.sleep(0.06)
    pairs = sorted((int(x["timestamp"]), float(x["openInterest"])) for x in rows)
    return [p[0] for p in pairs], [p[1] for p in pairs]
