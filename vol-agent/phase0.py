"""Fase 0: prova o canalizador sem estratégia e sem risco.
1) autentica e lê saldo  2) fixa alavancagem 1x  3) põe ordem limite PostOnly 10% abaixo do preço
4) confirma que está aberta  5) cancela  6) confirma que desapareceu e que não há posição.
Só corre em testnet.
"""
from decimal import Decimal

from bot.config import SYMBOL, load_settings
from bot.exchange import Exchange, ExchangeError


def main():
    s = load_settings(allow_mainnet=False)
    ex = Exchange(s)
    print(f"[1] ambiente: {'TESTNET' if ex.testnet else 'MAINNET'}  símbolo: {SYMBOL}")
    eq = ex.usdt_equity()
    print(f"[1] saldo USDT: {eq}")
    if eq <= 0:
        raise SystemExit("Saldo 0 na testnet: pede fundos de teste no site da testnet (Assets -> Faucet).")

    ex.set_leverage()
    print(f"[2] alavancagem {s.leverage}x definida")

    px = ex.last_price()
    limit_px = ex.round_price(px * Decimal("0.90"))
    qty = ex.min_valid_qty(limit_px)
    print(f"[3] preço {px}  ordem BUY PostOnly {qty} @ {limit_px} (~{qty*limit_px:.2f} USDT)")
    link = ex.place_limit_postonly("Buy", qty, limit_px)

    found = [o for o in ex.open_orders() if o["orderLinkId"] == link]
    assert found, "ordem não aparece nas ordens abertas!"
    print(f"[4] confirmada aberta: {found[0]['orderStatus']}")

    ex.cancel(link)
    still = [o for o in ex.open_orders() if o["orderLinkId"] == link]
    assert not still, "ordem continua aberta após cancelar!"
    print("[5] cancelada e confirmada")

    assert not ex.positions(), "há posição aberta inesperada!"
    print("[6] sem posições abertas\n\nFASE 0 (passo A) OK: autenticação, ordens e cancelamento funcionam.")


if __name__ == "__main__":
    try:
        main()
    except ExchangeError as e:
        raise SystemExit(f"ERRO: {e}")
