"""Helpers partilhados pelos routers: definições, preços, custo médio, câmbio."""
from .db import connect


def get_settings() -> dict:
    conn = connect()
    rows = conn.execute("SELECT chave, valor FROM settings").fetchall()
    conn.close()
    return {r["chave"]: r["valor"] for r in rows}


def get_setting(chave: str, default=None):
    return get_settings().get(chave, default)


def set_setting(chave: str, valor):
    conn = connect()
    with conn:
        conn.execute(
            "INSERT INTO settings (chave, valor) VALUES (?, ?) "
            "ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
            (chave, str(valor)),
        )
    conn.close()


def eur_usd(settings: dict = None) -> float:
    s = settings or get_settings()
    try:
        return float(s.get("eur_usd", "0.92"))
    except (TypeError, ValueError):
        return 0.92


def preco_cache(simbolo: str) -> dict:
    conn = connect()
    row = conn.execute("SELECT * FROM prices_cache WHERE simbolo = ?", (simbolo.upper(),)).fetchone()
    conn.close()
    return dict(row) if row else {}


def posicao_ativo(conn, asset_id: int) -> dict:
    """Custo médio e quantidade líquida a partir das transações (não fiscal)."""
    txs = conn.execute(
        "SELECT tipo, qtd, preco, taxas FROM transactions WHERE asset_id = ? ORDER BY data, id",
        (asset_id,),
    ).fetchall()
    qtd = 0.0
    custo = 0.0  # custo total das unidades ainda detidas (para custo médio móvel)
    for t in txs:
        if t["tipo"] == "buy":
            qtd += t["qtd"]
            custo += t["qtd"] * t["preco"] + (t["taxas"] or 0)
        elif t["tipo"] == "sell":
            if qtd > 0:
                custo_medio = custo / qtd
                custo -= min(t["qtd"], qtd) * custo_medio
            qtd -= t["qtd"]
    qtd = max(0.0, qtd)
    custo_medio = (custo / qtd) if qtd > 1e-12 else None
    return {"qtd": qtd, "custo_total": max(0.0, custo), "custo_medio": custo_medio}


DISCLAIMER = (
    "Isto não é aconselhamento financeiro nem fiscal. A app apresenta cálculos "
    "e sinais da tua regra pré-definida e estima números fiscais — não substitui "
    "contabilista. Não executa ordens."
)
