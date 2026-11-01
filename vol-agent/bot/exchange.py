"""Wrapper fino sobre a API V5 da Bybit com guardas de segurança."""
from __future__ import annotations

import uuid
from decimal import ROUND_DOWN, Decimal

from pybit.unified_trading import HTTP

from .config import CATEGORY, MAX_ORDER_NOTIONAL_USDT, SYMBOL, Settings


class ExchangeError(RuntimeError):
    pass


class Exchange:
    def __init__(self, s: Settings):
        self.http = HTTP(testnet=s.testnet, api_key=s.api_key, api_secret=s.api_secret)
        self.testnet = s.testnet
        self.cfg = s
        self._inst: dict | None = None

    # --- leitura ---
    def instrument(self) -> dict:
        if self._inst is None:
            r = self.http.get_instruments_info(category=CATEGORY, symbol=SYMBOL)["result"]["list"][0]
            self._inst = {
                "tick": Decimal(r["priceFilter"]["tickSize"]),
                "qty_step": Decimal(r["lotSizeFilter"]["qtyStep"]),
                "min_qty": Decimal(r["lotSizeFilter"]["minOrderQty"]),
                "min_notional": Decimal(r["lotSizeFilter"].get("minNotionalValue", "5")),
            }
        return self._inst

    def last_price(self) -> Decimal:
        r = self.http.get_tickers(category=CATEGORY, symbol=SYMBOL)["result"]["list"][0]
        return Decimal(r["lastPrice"])

    def usdt_equity(self) -> Decimal:
        r = self.http.get_wallet_balance(accountType="UNIFIED")["result"]["list"]
        for acct in r:
            for coin in acct["coin"]:
                if coin["coin"] == "USDT":
                    return Decimal(coin["walletBalance"] or "0")
        return Decimal("0")

    def positions(self) -> list[dict]:
        r = self.http.get_positions(category=CATEGORY, symbol=SYMBOL)["result"]["list"]
        return [p for p in r if Decimal(p["size"]) != 0]

    def open_orders(self) -> list[dict]:
        return self.http.get_open_orders(category=CATEGORY, symbol=SYMBOL)["result"]["list"]

    # --- escrita ---
    def set_leverage(self, lev: int | None = None):
        lev = self.cfg.leverage if lev is None else lev
        if not 1 <= lev <= self.cfg.max_leverage:
            raise ExchangeError(f"alavancagem {lev} fora de [1, {self.cfg.max_leverage}]")
        try:
            self.http.set_leverage(category=CATEGORY, symbol=SYMBOL,
                                   buyLeverage=str(lev), sellLeverage=str(lev))
        except Exception as e:                      # 110043 = leverage not modified (já está certo)
            if "110043" not in str(e):
                raise

    def round_price(self, px: Decimal) -> Decimal:
        t = self.instrument()["tick"]
        return (px / t).to_integral_value(ROUND_DOWN) * t

    def min_valid_qty(self, price: Decimal) -> Decimal:
        i = self.instrument()
        need = max(i["min_qty"], i["min_notional"] / price)
        steps = (need / i["qty_step"]).to_integral_value(rounding="ROUND_UP")
        return steps * i["qty_step"]

    def place_limit_postonly(self, side: str, qty: Decimal, price: Decimal, link_id: str | None = None) -> str:
        if qty * price > Decimal(str(MAX_ORDER_NOTIONAL_USDT)):
            raise ExchangeError(f"ordem {qty*price:.2f} USDT excede o máximo {MAX_ORDER_NOTIONAL_USDT}")
        link_id = link_id or f"bot-{uuid.uuid4().hex[:16]}"
        self.http.place_order(category=CATEGORY, symbol=SYMBOL, side=side, orderType="Limit",
                              qty=str(qty), price=str(price), timeInForce="PostOnly",
                              orderLinkId=link_id)
        return link_id

    def cancel(self, link_id: str):
        self.http.cancel_order(category=CATEGORY, symbol=SYMBOL, orderLinkId=link_id)
