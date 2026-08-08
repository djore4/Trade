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


def gate_trend_pullback(k: Klines, cfg: Config = DEFAULT,
                        funding_z: Optional[float] = None) -> Tuple[List[Setup], List[str]]:
    """Gate 1 v2 — pullback a um nível A FAVOR da tendência (secção 5.3).

    Hipótese: em cripto, o edge documentado é momentum/continuação — negoceia-se
    COM a tendência de fundo, entrando no recuo a um nível testado, nunca
    perseguindo nem adivinhando topos/fundos. Funding extremo do lado do trade
    é veto (lado sobrelotado). Devolve (setups, motivos_de_rejeicao).
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

    N = len(k.c)
    price = k.c[-1]
    need = cfg.trend_sma + cfg.trend_slope_bars + 1
    if N < need:
        return reject(f"série curta para medir a tendência (precisa de ≥{need} barras)")

    # ── 1. Tendência: SMA longa + declive. Sem tendência → sem trade (paciência). ──
    sma_now = sum(k.c[-cfg.trend_sma:]) / cfg.trend_sma
    sma_then = sum(k.c[-cfg.trend_sma - cfg.trend_slope_bars:-cfg.trend_slope_bars]) / cfg.trend_sma
    slope = sma_now - sma_then
    slope_min = cfg.trend_slope_atr * a
    if slope > slope_min and price > sma_now:
        direction = 1
    elif slope < -slope_min and price < sma_now:
        direction = -1
    else:
        return reject(f"sem tendência definida (SMA{cfg.trend_sma} com declive "
                      f"{slope / a:+.2f}×ATR em {cfg.trend_slope_bars} barras, "
                      f"preço {'acima' if price > sma_now else 'abaixo'} da média) "
                      f"— sem trade: paciência")

    # ── 2. Pullback: tem de haver recuo real desde o extremo recente (não perseguir). ──
    if direction > 0:
        recent_ext = max(k.h[-cfg.pullback_lookback:])
        depth = recent_ext - price
        ext_txt = "máximo"
    else:
        recent_ext = min(k.l[-cfg.pullback_lookback:])
        depth = price - recent_ext
        ext_txt = "mínimo"
    if depth < cfg.pullback_min_atr * a:
        return reject(f"pullback insuficiente ({depth / a:.2f}×ATR do {ext_txt} recente "
                      f"< {cfg.pullback_min_atr}×ATR) — isto seria perseguir o movimento; "
                      f"esperar o recuo")

    # ── 3. Nível de entrada. ──
    # Numa tendência o preço faz mínimos ASCENDENTES: cada recuo pára num preço
    # diferente, pelo que exigir um nível horizontal de ≥2 toques quase nunca se
    # verifica. Aceita-se por isso a referência mais próxima entre:
    #   (a) nível horizontal confirmado (≥min_touches toques), ou
    #   (b) o último swing confirmado do lado da entrada (mínimo numa tendência de
    #       alta, máximo numa de baixa) — a referência clássica do "recuo".
    pivots = swing_pivots(k, cfg.pivot_left, cfg.pivot_right)
    levels = [L for L in cluster_levels(pivots, cfg.cluster_tol_atr * a)
              if L.touches >= cfg.min_touches]
    lado = "suporte" if direction > 0 else "resistência"
    swing_type = "low" if direction > 0 else "high"
    swings = [p for p in pivots if p.type == swing_type and
              (p.price <= price if direction > 0 else p.price >= price)]
    last_swing = max(swings, key=lambda p: p.index) if swings else None

    refs: List[Tuple[float, str, int]] = []           # (preço, descrição, toques)
    if direction > 0:
        cands = [L for L in levels if L.price <= price]
        if cands:
            best = max(cands, key=lambda L: L.price)
            refs.append((best.price, f"{lado} de {best.touches} toques", best.touches))
        if last_swing:
            refs.append((last_swing.price, f"último mínimo de swing "
                                           f"(há {last_swing.bars_ago} barras)", 1))
        near_price, near_desc, near_touches = (max(refs, key=lambda r: r[0])
                                               if refs else (None, None, 0))
        dist = (price - near_price) if near_price is not None else None
    else:
        cands = [L for L in levels if L.price >= price]
        if cands:
            best = min(cands, key=lambda L: L.price)
            refs.append((best.price, f"{lado} de {best.touches} toques", best.touches))
        if last_swing:
            refs.append((last_swing.price, f"último máximo de swing "
                                           f"(há {last_swing.bars_ago} barras)", 1))
        near_price, near_desc, near_touches = (min(refs, key=lambda r: r[0])
                                               if refs else (None, None, 0))
        dist = (near_price - price) if near_price is not None else None

    if near_price is None:
        return reject(f"sem {lado} de referência abaixo do preço "
                      f"(nem nível confirmado nem swing) — sem zona de entrada")
    if dist > cfg.entry_tol_atr * a:
        return reject(f"tendência {'de alta' if direction > 0 else 'de baixa'} mas preço "
                      f"longe do {lado} mais próximo ({dist / a:.2f}×ATR > "
                      f"{cfg.entry_tol_atr}×ATR) — sem zona de entrada")

    # ── 4. Veto de funding (H1 usado como veto): não entrar no lado sobrelotado. ──
    if funding_z is not None:
        if direction > 0 and funding_z >= cfg.funding_z_veto:
            return reject(f"funding extremo (z=+{funding_z:.1f}) — lado LONG sobrelotado "
                          f"a pagar; veto de posicionamento")
        if direction < 0 and funding_z <= -cfg.funding_z_veto:
            return reject(f"funding extremo (z={funding_z:.1f}) — lado SHORT sobrelotado "
                          f"a pagar; veto de posicionamento")

    # ── 5. Risco/alvos — mesma mecânica da secção 6 (piso de custo, banda de ATR). ──
    cost_floor = cfg.cost_floor_mult * price * cfg.cost_rt()
    band_min = cfg.atr_band_min * a
    band_max = cfg.atr_band_max * a
    if cost_floor > band_max:
        return reject(
            f"ATR baixo demais: piso de custo ({cfg.cost_floor_mult}× round-trip = "
            f"{cost_floor / price * 100:.2f}%) ultrapassa o topo da banda de ATR "
            f"({cfg.atr_band_max}×ATR = {band_max / price * 100:.2f}%) → usar timeframe superior")
    min_stop_dist = max(band_min, cost_floor)

    stop = near_price - 0.15 * a if direction > 0 else near_price + 0.15 * a
    stop_dist = abs(price - stop)
    if stop_dist < min_stop_dist:
        stop_dist = min_stop_dist
        stop = price - stop_dist if direction > 0 else price + stop_dist
    if stop_dist > band_max:
        return reject(f"stop estrutural a {stop_dist / price * 100:.2f}% excede a banda de "
                      f"ATR ({cfg.atr_band_max}×ATR = {band_max / price * 100:.2f}%): "
                      f"risco por trade excessivo")

    # TP1 = nível oposto mais próximo além do piso de custo; TP2 = extremo recente.
    if direction > 0:
        opp = sorted((L for L in levels if L.price > price + cost_floor), key=lambda L: L.price)
        extreme_has_room = recent_ext > price + cost_floor
    else:
        opp = sorted((L for L in levels if L.price < price - cost_floor),
                     key=lambda L: L.price, reverse=True)
        extreme_has_room = recent_ext < price - cost_floor
    if not opp and not extreme_has_room:
        return reject(f"sem nível oposto acima do piso de custo "
                      f"({cost_floor / price * 100:.2f}%) — sem espaço para TP1")
    tp1 = opp[0].price if opp else recent_ext
    tp2 = recent_ext
    rr1 = abs(tp1 - price) / stop_dist
    rr2 = abs(tp2 - price) / stop_dist
    if rr1 < cfg.min_rr1:
        return reject(f"R:R até TP1 = {rr1:.2f} < {cfg.min_rr1}: alvo próximo demais "
                      f"para o stop exigido pelo piso de custo")

    rb = range_bounds(k, cfg.range_lookback)
    side_txt = "LONG a favor da tendência ↑" if direction > 0 else "SHORT a favor da tendência ↓"
    why = (f"{side_txt} (SMA{cfg.trend_sma} com declive {slope / a:+.2f}×ATR). "
           f"Pullback de {depth / a:.2f}×ATR desde o {ext_txt} recente {recent_ext:.6g}. "
           f"Entrada {price:.6g} junto ao {near_desc} "
           f"({near_price:.6g}, a {dist / a:.2f}×ATR). "
           f"Stop {stop:.6g} ({stop_dist / price * 100:.2f}%, piso de custo "
           f"{cfg.cost_floor_mult}× round-trip). "
           f"TP1 {tp1:.6g} (nível oposto mais próximo, R:R {rr1:.2f}); "
           f"TP2 {tp2:.6g} (extremo recente, R:R {rr2:.2f}).")

    setup = Setup(direction, price, stop, stop_dist, stop_dist / price,
                  tp1, tp2, rr1, rr2, a, levels, rb, why)
    return [setup], rejections
