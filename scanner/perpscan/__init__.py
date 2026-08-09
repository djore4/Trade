"""perpscan — camada estrutural do screener de perpétuos USDT (Bybit).

Módulos:
  structure  — Fase 1: atr, swing_pivots, cluster_levels, range_bounds (puros).
  gates      — Fase 2: gate_liquidity (Gate 0), gate_structure (Gate 1), binários.
  backtest   — Fase 3: triple_barrier, welch, sumários estatísticos.
  validate   — Fase 3: orquestração walk-forward + baseline + veredicto.
  bybit      — cliente REST Bybit v5 (única camada com rede; requer `requests`).
  synth      — geradores de séries sintéticas para testes.

Ver framework-trading-perpetuos.md (secções 5, 6, 8, 9).
"""
from .config import Config, DEFAULT  # noqa: F401
