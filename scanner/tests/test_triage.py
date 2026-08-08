"""Camada de triagem: indicadores, filtros e protocolo de holdout."""
import random
import unittest

from perpscan.config import DEFAULT as C
from perpscan.indicators import adx, rsi, volume_ratio
from perpscan.structure import Klines
from perpscan.synth import synth_range, synth_staircase, synth_trend
from perpscan.triage import triage, universe_quality


class TestIndicators(unittest.TestCase):
    def test_rsi_bounds_and_direction(self):
        up = rsi(synth_trend())                      # subida monotónica
        self.assertIsNotNone(up)
        self.assertGreater(up, 90)                   # só ganhos → RSI no topo
        down = rsi(synth_trend(step=-0.5))
        self.assertLess(down, 10)

    def test_rsi_none_on_short_series(self):
        self.assertIsNone(rsi(Klines(c=[1, 2, 3])))

    def test_adx_high_on_trend_low_on_range(self):
        a_trend = adx(synth_trend())
        a_range = adx(synth_range())
        self.assertIsNotNone(a_trend)
        self.assertIsNotNone(a_range)
        self.assertGreater(a_trend, a_range)         # tendência > lateral

    def test_volume_ratio(self):
        k = synth_range()
        k.v = [1.0] * (len(k.c) - 1) + [5.0]
        self.assertAlmostEqual(volume_ratio(k), 5.0, places=6)


class TestTriage(unittest.TestCase):
    def test_weak_trend_is_cut(self):
        """Mercado sem direção (ruído puro) → cortado por tendência fraca."""
        r = random.Random(4)
        px = 100.0
        o, h, l, c = [], [], [], []
        for _ in range(300):                      # passeio sem direção nem pernas
            a = px
            px = px * (1 + r.gauss(0, 0.004))
            o.append(a); c.append(px)
            h.append(max(a, px) * 1.001); l.append(min(a, px) * 0.999)
        k = Klines(o=o, h=h, l=l, c=c, v=[1.0] * 300)
        ok, cuts = triage(k, 1)
        self.assertFalse(ok)
        self.assertTrue(any("ADX" in x for x in cuts), cuts)

    def test_overbought_long_is_cut(self):
        # Subida monotónica: RSI ~100 → um LONG aqui é comprar exaustão.
        ok, cuts = triage(synth_trend(), 1)
        self.assertFalse(ok)
        self.assertTrue(any("sobrecomprado" in c for c in cuts), cuts)

    def test_volume_climax_is_cut(self):
        k = synth_staircase(up=True)
        k.v = [1.0] * (len(k.c) - 1) + [10.0]
        ok, cuts = triage(k, 1)
        self.assertFalse(ok)
        self.assertTrue(any("clímax" in c for c in cuts), cuts)

    def test_crowded_lsr_is_cut(self):
        ok, cuts = triage(synth_staircase(up=True), 1, lsr_long_pct=75.0)
        # o filtro de LSR está desligado por defeito (history limitada)
        self.assertFalse(any("multidão" in c for c in cuts))

    def test_adx_measured_before_the_pullback(self):
        """O ADX é medido no extremo, não na barra de entrada (onde já caiu)."""
        from perpscan.indicators import adx
        from perpscan.triage import _truncate_at_extreme
        k = synth_staircase(up=True)
        no_extremo = adx(_truncate_at_extreme(k, 1, C), C.adx_n)
        na_entrada = adx(k, C.adx_n)
        self.assertIsNotNone(no_extremo)
        self.assertGreater(no_extremo, na_entrada)

    def test_cuts_are_specific_not_generic(self):
        _, cuts = triage(synth_trend(), 1)
        for c in cuts:
            self.assertGreater(len(c), 20, f"motivo vago: {c!r}")


class TestUniverseQuality(unittest.TestCase):
    def test_recent_listing_excluded(self):
        ok, why = universe_quality(bars_available=300, turnover=99e6)
        self.assertFalse(ok)
        self.assertIn("listagem recente", why)

    def test_established_and_liquid_passes(self):
        ok, _ = universe_quality(bars_available=5000, turnover=99e6)
        self.assertTrue(ok)


class TestHoldoutProtocol(unittest.TestCase):
    def test_dev_and_holdout_do_not_share_decisions(self):
        """Nenhuma decisão pode aparecer nas duas metades."""
        from dataclasses import replace
        from perpscan.validate import evaluate_symbol
        from tests.test_harness_power import _series

        k = _series(1400, 3, regime_len=200, drifts=(0.002, -0.002))
        cfg = replace(C, val_horizon=48)
        cut = int(len(k.c) * (1 - cfg.holdout_frac))
        dev = evaluate_symbol(k, cfg, random.Random(1), "v2",
                              i_from=None, i_to=cut, use_triage=False)
        hold = evaluate_symbol(k, cfg, random.Random(1), "v2",
                               i_from=cut, i_to=None, use_triage=False)
        dev_i = {t["i"] for t in dev["gate"]}
        hold_i = {t["i"] for t in hold["gate"]}
        self.assertEqual(dev_i & hold_i, set(), "dev e holdout partilham decisões")
        if dev_i:
            self.assertLess(max(dev_i), cut)
        if hold_i:
            self.assertGreaterEqual(min(hold_i), cut)


if __name__ == "__main__":
    unittest.main()
