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

    # ── Gate 1 — estrutura (secção 5.2) ──
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

    # ── Fase 3 — validação (secção 8) ──
    val_tf: str = "60"
    val_kline_limit: int = 1000
    val_horizon: int = 48
    val_universe: int = 60
    val_baseline_mult: int = 3
    val_target_r: float = 1.5                     # alvo em R do baseline de controlo
    abandon_p: float = 0.05
    seed: int = 0x5EED                            # PRNG do baseline (reprodutível)

    def cost_rt(self) -> float:
        """Custo round-trip em fração de preço (≈ 0.0017)."""
        return 2 * self.cost_per_side / 100.0


DEFAULT = Config()
