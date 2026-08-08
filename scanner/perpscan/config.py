"""Configuração da camada estrutural.

Espelha `framework-trading-perpetuos.md` (Apêndice A) e a tab SCAN em JS.
Valores marcados [SUP] no framework são pontos de decisão do dono do sistema.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Config:
    # ── Custos (secção 6.1) ──
    cost_per_side: float = 0.055 + 0.030          # % por lado (fee taker + slippage)

    # ── Gate 0 — liquidez (secção 5.1) ──
    min_turnover: float = 30e6                    # [SUP] turnover 24h mínimo (USD)

    # ── Gate 1 — estrutura (secção 5.2, v1 — REJEITADA; mantida para comparação) ──
    tf: str = "15"                                # timeframe de trabalho
    kline_limit: int = 300
    atr_n: int = 14
    pivot_left: int = 3
    pivot_right: int = 3
    cluster_tol_atr: float = 0.6                  # [SUP] tolerância de cluster (× ATR)
    min_touches: int = 2
    range_lookback: int = 96                      # ≈ 24h em TF15
    dead_lo: float = 0.35                         # [SUP] zona morta
    dead_hi: float = 0.65
    atr_band_min: float = 1.0                     # [SUP] banda de distância ao stop (× ATR)
    atr_band_max: float = 2.5
    cost_floor_mult: float = 8.0                  # piso de custo = 8× round-trip (prompt §2)
    min_rr1: float = 1.0

    # ── Gate 1 v2 — pullback com a tendência (secção 5.3) ──
    trend_sma: int = 120                          # [SUP] SMA de tendência (≈5 dias em TF60)
    trend_slope_bars: int = 24                    # [SUP] barras para medir o declive da SMA
    trend_slope_atr: float = 0.1                  # [SUP] declive mínimo em ×ATR (senão "sem tendência")
    pullback_lookback: int = 48                   # [SUP] janela do extremo recente (≈2 dias)
    pullback_min_atr: float = 1.0                 # [SUP] recuo mínimo desde o extremo (senão "perseguir")
    entry_tol_atr: float = 0.5                    # [SUP] distância máx. ao nível para haver zona de entrada
    funding_z_veto: float = 2.0                   # veto: funding extremo do lado do trade
    funding_z_window: int = 100                   # períodos do z-score (~33 dias a 8h)
    funding_min_obs: int = 20                     # mínimo de observações para calcular z

    # ── Saída (v3): coerência com a tese de momentum (secção 6.5) ──
    # "tp" = barreiras limitadas (ÚNICA calibrada: E[R]~0 em martingala).
    # "trail" = stop dinâmico — EXPERIMENTAL, NÃO VALIDADO: sem alvo superior a
    # cauda é tão pesada que a média de R não é estimável nas amostras que temos
    # (E[R] aparente +0.13 numa martingala, onde tem de ser 0). Não usar para
    # decidir nada.
    exit_mode: str = "tp"
    trail_atr: float = 2.5
    # Alvo: "tp1" = nível oposto mais próximo (saída de reversão);
    #       "tp2" = extremo da tendência (coerente com a tese de momentum).
    target: str = "tp2"

    # ── Fase 3 — validação (secção 8) ──
    val_tf: str = "60"
    val_kline_limit: int = 1000
    val_months: float = 6.0                       # história alvo (≥6 meses, secção 8)
    val_horizon: int = 240                        # ~10 dias em TF60: espaço para a tendência
    val_universe: int = 50
    val_baseline_mult: int = 3
    val_target_r: float = 1.5                     # alvo em R do baseline de controlo
    abandon_p: float = 0.05
    analysis_window: int = 300                    # barras passadas ao gate em cada decisão
    seed: int = 0x5EED                            # PRNG do baseline (reprodutível)
    # Universo só-cripto: baseCoins não-cripto conhecidos (ações/metais tokenizados).
    # Lista curada — estende com --exclude no CLI se aparecerem mais.
    denylist_base: tuple = ("XAU", "XAG", "SPCX", "SNDK", "SOXL", "CYS")

    def cost_rt(self) -> float:
        """Custo round-trip em fração de preço (≈ 0.0017)."""
        return 2 * self.cost_per_side / 100.0


DEFAULT = Config()
