"""Fase 3 — testes da barreira tripla e da estatística."""
import unittest

from perpscan.backtest import triple_barrier, welch, summary
from perpscan.config import DEFAULT as C


class TestTripleBarrier(unittest.TestCase):
    def test_tp_hit_gives_positive_r_net_of_costs(self):
        r = triple_barrier([102, 105], [99.9, 99.9], [100, 105],
                           entry=100, stop=99, tp=104, direction=1,
                           cost_frac=C.cost_rt(), horizon=48)
        self.assertGreater(r, 3.5)
        self.assertLess(r, 4.1)

    def test_stop_hit_gives_minus_one_net_of_costs(self):
        r = triple_barrier([100.5, 101], [98, 98], [99, 98],
                           entry=100, stop=99, tp=104, direction=1,
                           cost_frac=C.cost_rt(), horizon=48)
        self.assertLess(r, -0.9)
        self.assertGreater(r, -1.3)

    def test_short_direction(self):
        # short: preço cai ao TP
        r = triple_barrier([100.1], [95], [96],
                           entry=100, stop=101, tp=96, direction=-1,
                           cost_frac=C.cost_rt(), horizon=48)
        self.assertGreater(r, 3.5)

    def test_timeout_marks_to_close(self):
        r = triple_barrier([100.2] * 3, [99.8] * 3, [100.2, 100.1, 100.05],
                           entry=100, stop=99, tp=110, direction=1,
                           cost_frac=C.cost_rt(), horizon=3)
        self.assertIsNotNone(r)
        self.assertLess(abs(r), 0.2)             # perto de breakeven


class TestStats(unittest.TestCase):
    def test_welch_detects_shift(self):
        a = [1.0, 1.1, 0.9, 1.05, 0.95] * 6
        b = [0.0, 0.1, -0.1, 0.05, -0.05] * 6
        t, p = welch(a, b)
        self.assertGreater(t, 0)
        self.assertLess(p, 0.05)

    def test_welch_no_shift_not_significant(self):
        a = [0.0, 0.1, -0.1] * 20
        b = [0.0, 0.1, -0.1] * 20
        _, p = welch(a, b)
        self.assertGreaterEqual(p, 0.05)

    def test_summary_keys(self):
        s = summary([1, -1, 1, -1])
        self.assertEqual(s["n"], 4)
        self.assertEqual(s["pos"], 50.0)


if __name__ == "__main__":
    unittest.main()
