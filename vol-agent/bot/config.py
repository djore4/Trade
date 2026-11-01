"""Configuração e limites de segurança. Os limites são código, não opção."""
import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

CATEGORY = "linear"          # USDT perpetuals
SYMBOL = "BTCUSDT"
MAX_ORDER_NOTIONAL_USDT = 50.0   # nenhuma ordem acima disto
MAX_POSITION_NOTIONAL_USDT = 100.0


@dataclass(frozen=True)
class Settings:
    api_key: str
    api_secret: str
    testnet: bool
    leverage: int        # escolhido por ti no .env (BYBIT_LEVERAGE)
    max_leverage: int    # teto de segurança, também no .env (BYBIT_MAX_LEVERAGE)


def load_settings(allow_mainnet: bool = False) -> Settings:
    env = os.getenv("BYBIT_ENV", "testnet").lower()
    if env not in ("testnet", "mainnet"):
        raise SystemExit(f"BYBIT_ENV inválido: {env!r} (usa testnet ou mainnet)")
    if env == "mainnet" and not allow_mainnet:
        raise SystemExit("Mainnet bloqueada. Passa allow_mainnet=True explicitamente (só depois da testnet validada).")
    key, secret = os.getenv("BYBIT_API_KEY", ""), os.getenv("BYBIT_API_SECRET", "")
    if not key or not secret:
        raise SystemExit("Faltam BYBIT_API_KEY / BYBIT_API_SECRET no .env")
    lev = int(os.getenv("BYBIT_LEVERAGE", "1"))
    cap = int(os.getenv("BYBIT_MAX_LEVERAGE", "10"))
    if not 1 <= lev <= cap:
        raise SystemExit(f"BYBIT_LEVERAGE={lev} fora de [1, {cap}] (teto BYBIT_MAX_LEVERAGE)")
    return Settings(key, secret, testnet=(env == "testnet"), leverage=lev, max_leverage=cap)
