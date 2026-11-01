"""Backtest: grid long-only em spot, ligado só em regime de range.

Hipótese (pré-registada antes de ver resultados):
  Em BTC/ETH, quando ADX está baixo e a largura das Bollinger está abaixo da
  mediana dos últimos 30 dias, o preço oscila dentro de um intervalo. Um grid
  long-only de N níveis, espaçados por ATR, captura essa oscilação com lucro
  líquido de fees. Fora desse regime o bot não abre posições novas.

Disciplina:
  - Indicadores calculados em barras fechadas; a decisão da barra t usa o regime de t-1.
  - Intrabar conservador: compras primeiro, vendas só de níveis comprados em barras anteriores.
  - Seleção de parâmetros SÓ no in-sample. O holdout (últimos 180 dias) é lido
    uma vez, com --holdout, para a configuração escolhida. Ver KILL_CRITERIA.

Uso:
  python backtest.py                 # otimiza e reporta in-sample
  python backtest.py --holdout       # avalia a config escolhida no holdout (uma vez!)
"""
from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import polars as pl

SYMBOLS = ["BTCUSDT", "ETHUSDT"]
INTERVAL = "60"
HOLDOUT_DAYS = 180
BARS_PER_YEAR = 24 * 365

# Escritos ANTES de correr. Se o holdout falhar algum, a estratégia morre — não se re-otimiza.
KILL_CRITERIA = {
    "holdout_return_pct_min": 0.0,          # lucro líquido de fees > 0
    "holdout_max_dd_pct_max": 25.0,         # drawdown máximo < 25%
    "holdout_profit_factor_min": 1.2,
    "holdout_round_trips_min": 30,          # amostra mínima
    "must_beat_always_on_grid": True,       # o filtro de regime tem de acrescentar valor
}


@dataclass(frozen=True)
class Params:
    adx_max: float = 20.0
    levels: int = 4
    step_atr: float = 1.0       # espaçamento entre níveis em ATR (>=1: maior que o ruído de uma barra)
    exit_on_trend: bool = True  # liquidar inventário quando o regime sai de range
    regime_filter: bool = True  # False = grid sempre ligado (benchmark)
    fee: float = 0.001          # 0,1% por lado (spot Bybit, tier base)
    slippage: float = 0.0005    # aplicado só a saídas a mercado


# ---------- indicadores (Wilder) ----------
def _rma(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full_like(x, np.nan)
    if len(x) < n:
        return out
    out[n - 1] = np.nanmean(x[:n])
    a = 1.0 / n
    for i in range(n, len(x)):
        out[i] = out[i - 1] + a * (x[i] - out[i - 1])
    return out


def indicators(df: pl.DataFrame, adx_len=14, atr_len=14, bb_len=20, bbw_lb=720) -> pl.DataFrame:
    h, l, c = (df[k].to_numpy() for k in ("high", "low", "close"))
    pc = np.roll(c, 1); pc[0] = c[0]
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    up, dn = h - np.roll(h, 1), np.roll(l, 1) - l
    up[0] = dn[0] = 0
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    ndm = np.where((dn > up) & (dn > 0), dn, 0.0)
    atr_a = _rma(tr, adx_len)
    pdi = 100 * _rma(pdm, adx_len) / atr_a
    ndi = 100 * _rma(ndm, adx_len) / atr_a
    dx = 100 * np.abs(pdi - ndi) / np.where(pdi + ndi == 0, np.nan, pdi + ndi)
    adx = _rma(np.nan_to_num(dx), adx_len)
    adx[: 2 * adx_len] = np.nan
    return (df.with_columns(pl.Series("atr", _rma(tr, atr_len)), pl.Series("adx", adx))
              .with_columns(((4 * pl.col("close").rolling_std(bb_len)) /
                             pl.col("close").rolling_mean(bb_len)).alias("bbw"))
              .with_columns(pl.col("bbw").rolling_median(bbw_lb).alias("bbw_med")))


# ---------- simulação ----------
def simulate(df: pl.DataFrame, p: Params, capital: float = 100.0) -> dict:
    """Ordens simuladas como num exchange real:
    - compra limite em bp: preenche a min(bp, open) se o low tocar (gap abaixo → melhor preço)
    - venda limite em sp: preenche a max(sp, open) se o high tocar
    - stop (ordem stop-market) abaixo do último nível: preenche a min(stop, open) com slippage
    - saída por mudança de regime: a mercado no fecho, com slippage
    Conservador: níveis comprados numa barra só podem vender na barra seguinte.
    """
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    atr, adx, bbw, bbm = (df[k].to_numpy() for k in ("atr", "adx", "bbw", "bbw_med"))
    n = len(c)
    ranging = (adx < p.adx_max) & (bbw < bbm) if p.regime_filter else np.isfinite(atr)
    ranging = np.nan_to_num(ranging.astype(float)).astype(bool)

    cash, eq = capital, np.empty(n)
    active, center, step, alloc = False, 0.0, 0.0, 0.0
    held: dict[int, tuple[float, int, float]] = {}   # nível -> (qtd, barra da compra, preço de compra)
    pnl_trades, fees_paid, bars_active = [], 0.0, 0

    def sell(lvl: int, px: float):
        nonlocal cash, fees_paid
        q, _, bpx = held.pop(lvl)
        proceeds = q * px * (1 - p.fee)
        fees_paid += q * px * p.fee
        pnl_trades.append(proceeds - q * bpx * (1 + p.fee))
        cash += proceeds

    for t in range(1, n):
        regime = ranging[t - 1]                       # decisão com info até t-1
        if not active and regime and np.isfinite(atr[t - 1]):
            active, center = True, c[t - 1]
            step = p.step_atr * atr[t - 1]
            alloc = cash / p.levels
        if not active:
            eq[t] = cash
            continue
        bars_active += 1
        stop_px = center - step * (p.levels + 1)
        # 1) stop primeiro se a barra abriu já abaixo dele (gap)
        if o[t] <= stop_px:
            for lvl in list(held):
                sell(lvl, o[t] * (1 - p.slippage))
            active = False
            eq[t] = cash
            continue
        # 2) compras nos níveis tocados
        if regime or not p.regime_filter:
            for lvl in range(1, p.levels + 1):
                bp = center - step * lvl
                if lvl not in held and l[t] <= bp and cash >= alloc * 0.99:
                    fill = min(bp, o[t])
                    spend = min(alloc, cash)
                    q = spend / (fill * (1 + p.fee))
                    fees_paid += q * fill * p.fee
                    cash -= spend
                    held[lvl] = (q, t, fill)
        # 3) stop intrabar
        if l[t] <= stop_px:
            for lvl in list(held):
                sell(lvl, stop_px * (1 - p.slippage))
            active = False
            eq[t] = cash
            continue
        # 4) vendas de níveis comprados em barras anteriores
        for lvl, (q, tb, _) in list(held.items()):
            sp = center - step * (lvl - 1)
            if tb < t and h[t] >= sp:
                sell(lvl, max(sp, o[t]))
        # 5) regime saiu de range
        if p.regime_filter and not ranging[t]:
            if p.exit_on_trend:
                for lvl in list(held):
                    sell(lvl, c[t] * (1 - p.slippage))
            if not held:
                active = False
        # 6) preço fugiu para cima sem inventário → re-centrar na próxima barra
        elif not held and c[t] > center + step:
            active = False
        eq[t] = cash + sum(q * c[t] for q, _, _ in held.values())
    eq[0] = capital
    return _metrics(eq, pnl_trades, fees_paid, bars_active, capital)


def _metrics(eq, trades, fees, bars_active, capital) -> dict:
    ret = eq[-1] / capital - 1
    peak = np.maximum.accumulate(eq)
    dd = ((peak - eq) / peak).max()
    r = np.diff(eq) / eq[:-1]
    sharpe = (r.mean() / r.std() * np.sqrt(BARS_PER_YEAR)) if r.std() > 0 else 0.0
    wins = sum(x for x in trades if x > 0); losses = -sum(x for x in trades if x < 0)
    years = len(eq) / BARS_PER_YEAR
    cagr = (eq[-1] / capital) ** (1 / years) - 1 if years > 0 and eq[-1] > 0 else -1
    return {
        "return_pct": round(100 * ret, 2), "cagr_pct": round(100 * cagr, 2),
        "max_dd_pct": round(100 * dd, 2), "sharpe": round(float(sharpe), 2),
        "calmar": round(cagr / dd, 2) if dd > 0 else 0.0,
        "round_trips": len(trades), "profit_factor": round(wins / losses, 2) if losses > 0 else float("inf"),
        "fees_paid": round(fees, 2), "time_active_pct": round(100 * bars_active / len(eq), 1),
    }


def buy_hold(df: pl.DataFrame, fee=0.001) -> dict:
    c = df["close"].to_numpy()
    eq = 100 * c / c[0] * (1 - fee) ** 2
    peak = np.maximum.accumulate(eq)
    return {"return_pct": round(eq[-1] - 100, 2), "max_dd_pct": round(100 * ((peak - eq) / peak).max(), 2)}


# ---------- pipeline ----------
def load(symbol: str) -> pl.DataFrame:
    return indicators(pl.read_parquet(Path("data") / f"{symbol}_{INTERVAL}.parquet"))


def split(df: pl.DataFrame):
    cut = df["time"].max() - pl.duration(days=HOLDOUT_DAYS)
    return df.filter(pl.col("time") < cut), df.filter(pl.col("time") >= cut)


GRID = {"adx_max": [18, 20, 25], "levels": [3, 4, 5], "step_atr": [1.5, 2.0, 3.0], "exit_on_trend": [True, False]}


def optimise(ins: dict[str, pl.DataFrame]) -> tuple[Params, list]:
    """Uma única config para BTC e ETH: maximiza o pior Calmar dos dois (robustez > pico)."""
    results = []
    for combo in itertools.product(*GRID.values()):
        p = Params(**dict(zip(GRID.keys(), combo)))
        per = {s: simulate(d, p) for s, d in ins.items()}
        if min(m["round_trips"] for m in per.values()) < 50:
            continue
        results.append((min(m["calmar"] for m in per.values()), p, per))
    results.sort(key=lambda x: x[0], reverse=True)
    return results[0][1], results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", action="store_true", help="avaliar a config escolhida no holdout (uma vez)")
    a = ap.parse_args()
    data = {s: split(load(s)) for s in SYMBOLS}
    ins = {s: d[0] for s, d in data.items()}

    best, results = optimise(ins)
    print("=== IN-SAMPLE — top 5 (critério: pior Calmar entre BTC e ETH) ===")
    for score, p, per in results[:5]:
        print(f"score={score:>6} {asdict(p)}")
        for s, m in per.items():
            print(f"    {s}: {m}")
    for s, d in ins.items():
        print(f"    buy&hold {s}: {buy_hold(d)}")
    Path("chosen_params.json").write_text(json.dumps(asdict(best), indent=2))
    print(f"\nConfig escolhida gravada em chosen_params.json: {asdict(best)}")

    if not a.holdout:
        print("\nHoldout NÃO avaliado. Quando estiveres pronto (uma única vez): python backtest.py --holdout")
        return

    print(f"\n=== HOLDOUT ({HOLDOUT_DAYS} dias) — config congelada ===")
    verdict = True
    for s, (_, ho) in data.items():
        m = simulate(ho, best)
        base = simulate(ho, Params(**{**asdict(best), "regime_filter": False}))
        bh = buy_hold(ho)
        checks = {
            "lucro>0": m["return_pct"] > KILL_CRITERIA["holdout_return_pct_min"],
            "dd<25%": m["max_dd_pct"] < KILL_CRITERIA["holdout_max_dd_pct_max"],
            "PF>=1.2": m["profit_factor"] >= KILL_CRITERIA["holdout_profit_factor_min"],
            "trades>=30": m["round_trips"] >= KILL_CRITERIA["holdout_round_trips_min"],
            "bate grid sempre-ligado": m["return_pct"] > base["return_pct"],
        }
        verdict &= all(checks.values())
        print(f"{s}: {m}\n    grid sempre ligado: {base}\n    buy&hold: {bh}\n    checks: {checks}")
    print("\nVEREDICTO:", "PASSA → avançar para testnet" if verdict else "FALHA → estratégia morta, não re-otimizar")


if __name__ == "__main__":
    main()
