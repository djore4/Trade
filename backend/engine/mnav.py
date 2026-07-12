"""Sinal mNAV da MSTR (§2.3).

mNAV = capitalização de mercado / (BTC em tesouraria × preço BTC)
capitalização = ações em circulação × preço MSTR

O nº de BTC e as ações são inputs manuais com data. O preço BTC e MSTR podem
vir de fonte pública ou ser manuais. Nunca inventamos estes valores.
"""
from typing import Optional


def calcula(
    mstr_preco: Optional[float],
    shares_outstanding: Optional[float],
    btc_treasury: Optional[float],
    btc_preco: Optional[float],
    favoravel: float,
    travar: float,
) -> dict:
    if not all([mstr_preco, shares_outstanding, btc_treasury, btc_preco]) or btc_treasury <= 0 or btc_preco <= 0:
        return {
            "mnav": None,
            "sinal": "sem_dados",
            "motivo": "Faltam inputs (preço MSTR, ações, BTC em tesouraria ou preço BTC).",
        }

    market_cap = mstr_preco * shares_outstanding
    valor_btc = btc_treasury * btc_preco
    mnav = market_cap / valor_btc

    if mnav <= favoravel:
        sinal = "favoravel"
        motivo = f"mNAV {mnav:.2f}× ≤ {favoravel:.2f}× — zona favorável (alavancagem a BTC sem prémio)."
    elif mnav > travar:
        sinal = "travar"
        motivo = f"mNAV {mnav:.2f}× > {travar:.2f}× — prémio esticado, travar acumulação."
    else:
        sinal = "neutro"
        motivo = f"mNAV {mnav:.2f}× entre {favoravel:.2f}× e {travar:.2f}× — neutro."

    return {
        "mnav": round(mnav, 3),
        "market_cap": market_cap,
        "valor_btc": valor_btc,
        "sinal": sinal,
        "motivo": motivo,
    }
