"""Fase 2 — testes dos gates. Pelo menos quatro cenários, três com zero setups,
cada um com motivo distinto (prompt Fase 2)."""
import unittest

from perpscan.gates import gate_liquidity, gate_structure
from perpscan.synth import synth_range, synth_trend


class TestGate0(unittest.TestCase):
    def test_pass_when_liquid(self):
        self.assertTrue(gate_liquidity({"turnover": 50e6, "price": 1.0}).ok)

    def test_reject_low_turnover_with_specific_reason(self):
        r = gate_liquidity({"turnover": 5e6, "price": 1.0})
        self.assertFalse(r.ok)
        self.assertIn("liquidez insuficiente", r.reason)

    def test_reject_bad_price(self):
        self.assertFalse(gate_liquidity({"turnover": 50e6, "price": 0.0}).ok)


class TestGate1(unittest.TestCase):
    def test_range_bottom_yields_one_long_setup(self):
        setups, rej = gate_structure(synth_range(end_frac=0.03))
        self.assertEqual(len(setups), 1)
        s = setups[0]
        self.assertEqual(s.direction, 1)                     # LONG
        self.assertLessEqual(s.tp1, s.tp2 + 1e-9)            # TP1 = oposto ≤ TP2 extremo
        self.assertGreater(s.stop_dist, 0)
        self.assertIn("TP1", s.why)                          # justificação legível

    def test_dead_zone_zero_setups(self):
        setups, rej = gate_structure(synth_range(end_frac=0.50))
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("zona morta" in m for m in rej))

    def test_low_volatility_suggests_higher_timeframe(self):
        setups, rej = gate_structure(synth_range(lo=100.0, hi=100.4, end_frac=0.03))
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("timeframe superior" in m for m in rej))

    def test_trend_zero_setups_no_levels(self):
        setups, rej = gate_structure(synth_trend())
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("sem níveis confirmados" in m for m in rej))

    def test_three_distinct_rejection_reasons(self):
        _, r_dead = gate_structure(synth_range(end_frac=0.50))
        _, r_vol = gate_structure(synth_range(lo=100.0, hi=100.4, end_frac=0.03))
        _, r_trend = gate_structure(synth_trend())
        reasons = {r_dead[0], r_vol[0], r_trend[0]}
        self.assertEqual(len(reasons), 3)                    # três motivos distintos

    def test_cost_floor_enforced(self):
        # o stop nunca fica abaixo do piso de custo (8× round-trip)
        s = gate_structure(synth_range(end_frac=0.03))[0][0]
        cost_floor_pct = 8 * (2 * (0.055 + 0.030) / 100)
        self.assertGreaterEqual(s.stop_pct + 1e-9, cost_floor_pct)


if __name__ == "__main__":
    unittest.main()
