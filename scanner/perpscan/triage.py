"""Camada de triagem (secção 7) — decide QUAIS dos setups aprovados vale a pena
sequer considerar.

Não cria setups nem os pontua para os ressuscitar: só **corta**. Um setup que o
gate rejeitou continua rejeitado — a triagem nunca compensa um gate (princípio
não-negociável da secção 1).

Objetivo aritmético: cada trade paga uma portagem fixa em R (custo round-trip /
distância do stop). Fazer 1/5 das trades, ficando com as melhores, paga a
portagem 5× menos vezes. É esta a alavanca — não "acertar mais", mas
**negociar menos**.

Todos os limiares são valores de manual (ADX 25 = tendência estabelecida; RSI
70/30 = sobrecomprado/sobrevendido), não números procurados nos dados.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

from .config import Config, DEFAULT
from .indicators import adx, rsi, volume_ratio
from .structure import Klines


def _truncate_at_extreme(k: Klines, direction: int, cfg: Config) -> Klines:
    """Corta a série no extremo recente (o topo do movimento antes do recuo)."""
    n = len(k.c)
    lb = min(cfg.pullback_lookback, n)
    seg = range(n - lb, n)
    idx = (max(seg, key=lambda i: k.h[i]) if direction > 0
           else min(seg, key=lambda i: k.l[i]))
    end = idx + 1
    if end < cfg.adx_n * 3:                      # série curta demais para o ADX
        end = n
    return Klines(o=k.o[:end], h=k.h[:end], l=k.l[:end], c=k.c[:end],
                  v=k.v[:end], t=k.t[:end] if k.t else [])


def triage(k: Klines, direction: int, cfg: Config = DEFAULT,
           lsr_long_pct: Optional[float] = None) -> Tuple[bool, List[str]]:
    """Devolve (passa, motivos_de_corte). Motivos específicos, como nos gates."""
    cuts: List[str] = []

    # 1. Força da tendência — medida NO EXTREMO, antes do recuo.
    #    Medir o ADX na barra de entrada seria contraditório: durante um recuo o
    #    ADX cai por construção, logo exigir ADX alto no recuo é exigir que o
    #    recuo não exista. O que interessa é a força da tendência que agora fez
    #    uma pausa — por isso a série é truncada no extremo recente.
    if cfg.triage_adx:
        a = adx(_truncate_at_extreme(k, direction, cfg), cfg.adx_n)
        if a is None:
            cuts.append("série curta para ADX")
        elif a < cfg.adx_min:
            cuts.append(f"ADX {a:.1f} < {cfg.adx_min} no extremo — a tendência que "
                        f"pausou era fraca demais para uma tese de continuação")

    # 2. Exaustão. Entrar num recuo é comprar fraqueza temporária; se o RSI já
    #    está esticado NA DIREÇÃO DO TRADE, o movimento já foi feito.
    if cfg.triage_rsi:
        r = rsi(k, cfg.rsi_n)
        if r is None:
            cuts.append("série curta para RSI")
        elif direction > 0 and r >= cfg.rsi_high:
            cuts.append(f"RSI {r:.0f} ≥ {cfg.rsi_high} — sobrecomprado, "
                        f"o movimento já foi feito")
        elif direction < 0 and r <= cfg.rsi_low:
            cuts.append(f"RSI {r:.0f} ≤ {cfg.rsi_low} — sobrevendido, "
                        f"o movimento já foi feito")

    # 3. Clímax de volume. Volume muito acima do normal num recuo é distribuição
    #    ou pânico, não uma pausa ordenada.
    if cfg.triage_volume:
        vr = volume_ratio(k, cfg.vol_n)
        if vr is not None and vr >= cfg.vol_climax:
            cuts.append(f"volume {vr:.1f}× a média — clímax, não é um recuo ordenado")

    # 4. Posicionamento do crowd (long/short ratio). Estar do mesmo lado de uma
    #    multidão muito concentrada é o lado errado do fade.
    if cfg.triage_lsr and lsr_long_pct is not None:
        if direction > 0 and lsr_long_pct >= cfg.lsr_crowded:
            cuts.append(f"{lsr_long_pct:.0f}% das contas em long — "
                        f"multidão do mesmo lado do trade")
        elif direction < 0 and (100.0 - lsr_long_pct) >= cfg.lsr_crowded:
            cuts.append(f"{100.0 - lsr_long_pct:.0f}% das contas em short — "
                        f"multidão do mesmo lado do trade")

    return (not cuts), cuts


def universe_quality(bars_available: int, turnover: float,
                     cfg: Config = DEFAULT) -> Tuple[bool, str]:
    """Filtro de qualidade do universo (triagem 'fundamental' mínima).

    Tokens acabados de listar não têm história para o modelo se apoiar e
    comportam-se como lotaria de listagem. Exige-se histórico mínimo e liquidez
    acima do piso do Gate 0.
    """
    if bars_available < cfg.min_history_bars:
        return False, (f"histórico insuficiente: {bars_available} barras < "
                       f"{cfg.min_history_bars} — listagem recente")
    if turnover < cfg.quality_turnover:
        return False, (f"turnover {turnover / 1e6:.1f}M < "
                       f"{cfg.quality_turnover / 1e6:.0f}M para o universo de qualidade")
    return True, "ok"
