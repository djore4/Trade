"""Configuração e acesso a segredos.

Regra de ouro: chaves de API vivem apenas em variáveis de ambiente (`.env`).
Nunca em código, nunca na base de dados, nunca na UI, nunca em logs.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = os.environ.get("DB_PATH", str(ROOT / "data" / "console.db"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

# --- Definições por omissão (podem ser alteradas em M7 — Definições) ---
DEFAULT_SETTINGS = {
    "eur_usd": "0.92",           # taxa EUR/USD (1 USD = X EUR) — override manual
    "eur_usd_fonte": "manual",
    "dca_cadencia": "quinzenal", # quinzenal | mensal
    "janela_topo_dias": "75",    # janela do máximo (60–90)
    "escada_1": "15",            # % queda -> 1x
    "escada_2": "25",            # % queda -> 2x
    "escada_3": "35",            # % queda -> 3x
    "mnav_favoravel": "1.1",     # <= favorável
    "mnav_travar": "2.0",        # >  travar
    "alvo_L1": "30",
    "alvo_RWA": "15",
    "alvo_perp-DEX": "15",
    "alvo_BTC-alavancado": "25",
    "alvo_PPR": "15",
    "aviso_concentracao": "40",  # % acima do qual alerta concentração
}


def bybit_keys():
    """Devolve (key, secret) das variáveis de ambiente, ou (None, None)."""
    key = os.environ.get("BYBIT_API_KEY") or None
    secret = os.environ.get("BYBIT_API_SECRET") or None
    return key, secret


def bybit_configured() -> bool:
    key, secret = bybit_keys()
    return bool(key and secret)


def bybit_env() -> str:
    return os.environ.get("BYBIT_ENV", "mainnet")
