"""Simulador de posições alavancadas (perps) — §2.4.

Fórmulas DISTINTAS para linear (USDT-margined, payoff linear) e inverso
(coin-margined, payoff não-linear). Liquidação marcada como APROXIMAÇÃO
(margem isolada; exclui taxas e margem de manutenção real — na prática liquida
antes). Funding é subtraído ao P&L bruto.

Convenções de `qtd`:
  - linear : quantidade do ativo base (ex.: nº de ADA).
  - inverse: notional em USD (nº de contratos), típico dos coin-margined.
Funding acumulado (`funding_acum`) é tratado em USD (aproximação documentada);
positivo = funding pago (reduz P&L).
"""
from typing import Optional


def preco_liquidacao(direcao: str, contrato: str, entrada: float, alavancagem: float, mmr: float = 0.005) -> Optional[float]:
    """Preço de liquidação aproximado (margem isolada)."""
    if not entrada or not alavancagem or alavancagem <= 0:
        return None
    L = alavancagem
    if contrato == "linear":
        # Linear: liq ~ entrada * (1 -/+ 1/L +/- mmr)
        if direcao == "long":
            return entrada * (1 - 1 / L + mmr)
        return entrada * (1 + 1 / L - mmr)
    else:
        # Inverso (coin-margined): payoff em 1/preço
        if direcao == "long":
            return entrada * L / (L + 1 - mmr * L)
        return entrada * L / (L - 1 + mmr * L)


def avalia(
    direcao: str,
    contrato: str,
    entrada: float,
    qtd: float,
    alavancagem: float,
    funding_acum: float,
    mark: Optional[float],
    mmr: float,
    eur_usd: float,
) -> dict:
    """Devolve liquidação, P&L bruto/líquido (USD e EUR), ROI e distância à liq."""
    liq = preco_liquidacao(direcao, contrato, entrada, alavancagem, mmr)
    out = {
        "liquidacao": round(liq, 6) if liq else None,
        "liquidacao_aprox": True,  # honestidade dos números
        "dist_liq_pct": None,
        "pnl_bruto_usd": None,
        "funding_usd": round(funding_acum, 2),
        "pnl_liq_usd": None,
        "pnl_liq_eur": None,
        "roi_margem_pct": None,
        "margem_usd": None,
    }

    if mark and liq is not None and mark > 0:
        # distância percentual do mark à liquidação
        out["dist_liq_pct"] = round((mark - liq) / mark * 100.0, 2)

    if not mark or mark <= 0 or not entrada or entrada <= 0:
        return out

    sign = 1.0 if direcao == "long" else -1.0

    if contrato == "linear":
        # P&L (USDT) = (mark - entrada) * qtd * sign
        pnl_bruto = (mark - entrada) * qtd * sign
        margem = (entrada * qtd) / alavancagem if alavancagem else None
    else:
        # Inverso: P&L (em coin) = notional * (1/entrada - 1/mark) * sign
        pnl_coin = qtd * (1 / entrada - 1 / mark) * sign
        pnl_bruto = pnl_coin * mark  # converter coin->USD ao preço mark
        # margem inicial em coin -> USD
        margem_coin = (qtd / entrada) / alavancagem if alavancagem else None
        margem = margem_coin * mark if margem_coin is not None else None

    pnl_liq = pnl_bruto - funding_acum
    out["pnl_bruto_usd"] = round(pnl_bruto, 2)
    out["pnl_liq_usd"] = round(pnl_liq, 2)
    out["pnl_liq_eur"] = round(pnl_liq * eur_usd, 2)
    out["margem_usd"] = round(margem, 2) if margem else None
    if margem:
        out["roi_margem_pct"] = round(pnl_liq / margem * 100.0, 2)
    return out


def simula_saida(
    direcao: str,
    contrato: str,
    entrada: float,
    qtd: float,
    alavancagem: float,
    funding_acum: float,
    mmr: float,
    eur_usd: float,
    precos_saida: list,
) -> list:
    """Simula P&L líquido para uma lista de preços de saída."""
    linhas = []
    for p in precos_saida:
        r = avalia(direcao, contrato, entrada, qtd, alavancagem, funding_acum, p, mmr, eur_usd)
        linhas.append({
            "preco_saida": p,
            "pnl_liq_usd": r["pnl_liq_usd"],
            "pnl_liq_eur": r["pnl_liq_eur"],
            "roi_margem_pct": r["roi_margem_pct"],
        })
    return linhas
