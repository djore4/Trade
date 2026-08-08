"""Fase 2 — gates de seleção estrutural (secção 5 do framework).

Ambos os gates são BINÁRIOS: nenhuma pontuação os compensa. Os motivos de
rejeição são obrigatórios e específicos.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

from .config import Config, DEFAULT
from .structure import (
    Klines, Level, RangeBounds, atr, swing_pivots, cluster_levels, range_bounds,
)


@dataclass
class GateResult:
    ok: bool
    reason: str


@dataclass
class Setup:
    direction: int          # +1 LONG, -1 SHORT
    entry: float
    stop: float
    stop_dist: float
    stop_pct: float
    tp1: float
    tp2: float
    rr1: float
    rr2: float
    atr: float
    levels: List[Level]
    range: RangeBounds
    why: str


def gate_liquidity(mkt: dict, cfg: Config = DEFAULT) -> GateResult:
    """Gate 0 — liquidez. `mkt` tem pelo menos {'turnover', 'price'}."""
    turnover = mkt.get("turnover", 0.0)
    price = mkt.get("price", 0.0)
    if not (turnover >= cfg.min_turnover):
        return GateResult(False,
                          f"liquidez insuficiente: turnover 24h {turnover/1e6:.1f}M "
                          f"< {cfg.min_turnover/1e6:.0f}M [SUP §5]")
    if not (price and price > 0):
        return GateResult(False, "preço inválido/indisponível")
    return GateResult(True, f"turnover 24h {turnover/1e6:.1f}M ≥ {cfg.min_turnover/1e6:.0f}M")


def gate_structure(k: Klines, cfg: Config = DEFAULT) -> Tuple[List[Setup], List[str]]:
    """Gate 1 — estrutura. Devolve (setups, motivos_de_rejeicao).

    A ordem dos passos é a ordem em que rejeitam (secção 5.2).
    """
    rejections: List[str] = []

    def reject(msg: str) -> Tuple[List[Setup], List[str]]:
        rejections.append(msg)
        return [], rejections

    a = atr(k, cfg.atr_n)
    if a is None:
        return reject("série de klines demasiado curta para ATR")
    if not (a > 0):
        return reject("ATR nulo — sem volatilidade mensurável")

    rb = range_bounds(k, cfg.range_lookback)
    price = rb.price

    # Zona morta: preço a meio do range não tem trade estrutural.
    if cfg.dead_lo < rb.pos < cfg.dead_hi:
        return reject(f"preço no percentil {rb.pos*100:.0f}% do range — zona morta "
                      f"({cfg.dead_lo*100:.0f}–{cfg.dead_hi*100:.0f}%): sem borda estrutural")

    direction = 1 if rb.pos <= cfg.dead_lo else -1     # fundo→LONG, topo→SHORT

    pivots = swing_pivots(k, cfg.pivot_left, cfg.pivot_right)
    levels = [L for L in cluster_levels(pivots, cfg.cluster_tol_atr * a)
              if L.touches >= cfg.min_touches]
    if not levels:
        return reject(f"sem níveis confirmados (≥{cfg.min_touches} toques) "
                      f"na tolerância de {cfg.cluster_tol_atr}×ATR")

    # ── Piso de custo e banda de ATR (secção 6.2) ──
    cost_rt_price = price * cfg.cost_rt()
    cost_floor = cfg.cost_floor_mult * cost_rt_price
    band_min = cfg.atr_band_min * a
    band_max = cfg.atr_band_max * a

    if cost_floor > band_max:
        return reject(
            f"ATR baixo demais: piso de custo ({cfg.cost_floor_mult}× round-trip = "
            f"{cost_floor/price*100:.2f}%) ultrapassa o topo da banda de ATR "
            f"({cfg.atr_band_max}×ATR = {band_max/price*100:.2f}%). "
            f"Nenhum stop cabe acima do piso e dentro da banda → usar timeframe superior")

    min_stop_dist = max(band_min, cost_floor)
    if min_stop_dist > band_max:
        return reject(
            f"distância mínima ao stop ({min_stop_dist/price*100:.2f}%) excede o topo "
            f"da banda de ATR ({band_max/price*100:.2f}%) → usar timeframe superior")

    # Entrada = preço atual; stop do lado da entrada.
    entry = price
    stop_from: Optional[Level] = None
    if direction > 0:
        below = sorted((L for L in levels if L.price < entry),
                       key=lambda L: L.price, reverse=True)
        stop_from = below[0] if below else None
        stop = (stop_from.price - 0.15 * a) if stop_from else entry - min_stop_dist
    else:
        above = sorted((L for L in levels if L.price > entry), key=lambda L: L.price)
        stop_from = above[0] if above else None
        stop = (stop_from.price + 0.15 * a) if stop_from else entry + min_stop_dist

    stop_dist = abs(entry - stop)
    if stop_dist < min_stop_dist:
        stop_dist = min_stop_dist
        stop = entry - stop_dist if direction > 0 else entry + stop_dist
    if stop_dist > band_max:
        return reject(
            f"stop estrutural a {stop_dist/price*100:.2f}% excede a banda de ATR "
            f"({cfg.atr_band_max}×ATR = {band_max/price*100:.2f}%): risco por trade excessivo")

    # Alvos: TP1 = nível oposto mais próximo; TP2 = extremo do range.
    if direction > 0:
        opp = sorted((L for L in levels if L.price > entry + cost_floor), key=lambda L: L.price)
    else:
        opp = sorted((L for L in levels if L.price < entry - cost_floor),
                     key=lambda L: L.price, reverse=True)
    range_extreme = rb.hi if direction > 0 else rb.lo
    extreme_has_room = (range_extreme > entry + cost_floor) if direction > 0 \
        else (range_extreme < entry - cost_floor)
    if not opp and not extreme_has_room:
        return reject(f"sem nível oposto acima do piso de custo "
                      f"({cost_floor/price*100:.2f}%) — sem espaço para TP1")

    tp1 = opp[0].price if opp else range_extreme
    tp2 = range_extreme
    rr1 = abs(tp1 - entry) / stop_dist
    rr2 = abs(tp2 - entry) / stop_dist
    if rr1 < cfg.min_rr1:
        return reject(f"R:R até TP1 = {rr1:.2f} < {cfg.min_rr1}: alvo próximo demais "
                      f"para o stop exigido pelo piso de custo")

    side_txt = "LONG (fundo do range)" if direction > 0 else "SHORT (topo do range)"
    anchor = (f", ancorado no nível de {stop_from.touches} toques" if stop_from
              else ", sem nível — piso de custo/ATR")
    why = (f"{side_txt}. {rb.why}. "
           f"Stop em {stop:.6g} ({stop_dist/price*100:.2f}% ≈ {stop_dist/a:.2f}×ATR{anchor}). "
           f"Piso de custo {cfg.cost_floor_mult}× round-trip = {cost_floor/price*100:.2f}%. "
           f"TP1 {tp1:.6g} (nível oposto mais próximo, R:R {rr1:.2f}); "
           f"TP2 {tp2:.6g} (extremo do range, R:R {rr2:.2f}).")

    setup = Setup(direction, entry, stop, stop_dist, stop_dist / price,
                  tp1, tp2, rr1, rr2, a, levels, rb, why)
    return [setup], rejections
