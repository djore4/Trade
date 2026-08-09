"""Fase 1 — testes do extrator estrutural com séries sintéticas."""
import unittest

from perpscan.config import DEFAULT as C
from perpscan.structure import atr, swing_pivots, cluster_levels, range_bounds
from perpscan.synth import synth_range, synth_trend


class TestStructure(unittest.TestCase):
    def test_atr_positive_on_range(self):
        self.assertGreater(atr(synth_range()), 0)

    def test_atr_none_on_short_series(self):
        from perpscan.structure import Klines
        self.assertIsNone(atr(Klines(h=[1, 2], l=[0, 1], c=[1, 2])))

    def test_range_has_two_confirmed_levels(self):
        k = synth_range()
        levels = [L for L in cluster_levels(swing_pivots(k), C.cluster_tol_atr * atr(k))
                  if L.touches >= C.min_touches]
        self.assertGreaterEqual(len(levels), 2)
        # um suporte (fundo) e uma resistência (topo)
        kinds = {L.kind for L in levels}
        self.assertIn("suporte", kinds)
        self.assertIn("resistência", kinds)

    def test_level_has_readable_justification(self):
        k = synth_range()
        levels = cluster_levels(swing_pivots(k), C.cluster_tol_atr * atr(k))
        self.assertTrue(levels)
        self.assertIn("toque", levels[0].why)
        self.assertIn("barras", levels[0].why)

    def test_pivots_do_not_repaint(self):
        # nenhum pivot pode estar nas últimas `right` barras (não confirmado)
        k = synth_range()
        piv = swing_pivots(k, C.pivot_left, C.pivot_right)
        self.assertTrue(all(p.bars_ago >= C.pivot_right for p in piv))

    def test_range_position_bottom_vs_mid(self):
        self.assertLessEqual(range_bounds(synth_range(end_frac=0.03)).pos, C.dead_lo)
        mid = range_bounds(synth_range(end_frac=0.50)).pos
        self.assertTrue(C.dead_lo < mid < C.dead_hi)

    def test_trend_has_no_confirmed_levels(self):
        k = synth_trend()
        levels = [L for L in cluster_levels(swing_pivots(k), C.cluster_tol_atr * (atr(k) or 1))
                  if L.touches >= C.min_touches]
        self.assertEqual(len(levels), 0)


if __name__ == "__main__":
    unittest.main()
