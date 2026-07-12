"""Camada de acesso a SQLite: ligação, criação do esquema e seed do scaffold.

O seed cria contas e o catálogo de ativos (símbolos + quadrante). NÃO inventa
quantidades, preços, cotações nem dados fiscais — esses são sempre input do
utilizador (anti-requisito §11).
"""
import sqlite3
import sys
from pathlib import Path

from . import config

SCHEMA = Path(__file__).parent / "schema.sql"


def connect() -> sqlite3.Connection:
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """Cria o esquema (idempotente) e garante as definições por omissão."""
    conn = connect()
    with conn:
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
        for chave, valor in config.DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (chave, valor) VALUES (?, ?)",
                (chave, valor),
            )
    conn.close()


def _seed(conn: sqlite3.Connection):
    """Scaffold inicial da carteira descrita no brief (§1). Sem valores inventados."""
    if conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] > 0:
        return  # já existe scaffold; não duplicar

    contas = [
        ("Bybit", "spot", "eu"),
        ("Bybit (derivados)", "derivados", "eu"),
        ("Trading 212", "acao", "eu"),
        ("PPR", "ppr", "patricia"),
    ]
    ids = {}
    for nome, tipo, owner in contas:
        cur = conn.execute(
            "INSERT INTO accounts (nome, tipo, owner) VALUES (?, ?, ?)",
            (nome, tipo, owner),
        )
        ids[nome] = cur.lastrowid

    # Catálogo de ativos: símbolo + quadrante (estrutura, não dados financeiros)
    ativos = [
        ("ADA", "Cardano", "USD", "L1", "Bybit", "eu"),
        ("NEAR", "NEAR Protocol", "USD", "L1", "Bybit", "eu"),
        ("ONDO", "Ondo Finance", "USD", "RWA", "Bybit", "eu"),
        ("HYPE", "Hyperliquid", "USD", "perp-DEX", "Bybit", "eu"),
        ("JUP", "Jupiter", "USD", "perp-DEX", "Bybit", "eu"),
        ("MSTR", "MicroStrategy (BTC alavancado)", "USD", "BTC-alavancado", "Trading 212", "eu"),
    ]
    for simbolo, nome, moeda, quad, conta, owner in ativos:
        cur = conn.execute(
            """INSERT INTO assets (simbolo, nome, moeda, quadrante, account_id, owner)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (simbolo, nome, moeda, quad, ids[conta], owner),
        )
        # Linha de reserva por ativo de acumulação (valores a 0 — utilizador define)
        conn.execute(
            "INSERT OR IGNORE INTO reserve_budget (asset_id) VALUES (?)",
            (cur.lastrowid,),
        )

    # PPR — titularidade distinta (Patrícia). Valores a 0 até input manual.
    conn.execute(
        """INSERT INTO ppr (nome, owner, investido, valor, data_atualizacao)
           VALUES ('Save & Grow (Casa de Investimentos)', 'patricia', 0, 0, NULL)""",
    )


def seed():
    conn = connect()
    with conn:
        _seed(conn)
    conn.close()


if __name__ == "__main__":
    init_db()
    if "--seed" in sys.argv:
        seed()
        print(f"Base de dados criada e scaffold aplicado em {config.DB_PATH}")
    else:
        print(f"Esquema garantido em {config.DB_PATH}")
