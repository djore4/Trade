"""Gate 1 v2 — pullback com a tendência. Cenários com séries sintéticas:
um aprovado e vários recusados, cada um com motivo distinto e específico."""
import random
import unittest
from dataclasses import replace

from perpscan.config import DEFAULT as C
from perpscan.gates import gate_trend_pullback
from perpscan.synth import (STAIRCASE_UP, synth_range, synth_staircase)
from perpscan.validate import evaluate_symbol


class TestGateTrendPullback(unittest.TestCase):
    def test_uptrend_pullback_yields_long(self):
        # Escada ascendente que termina num recuo ao suporte → 1 setup LONG.
        setups, rej = gate_trend_pullback(synth_staircase(up=True))
        self.assertEqual(len(setups), 1, rej)
        s = setups[0]
        self.assertEqual(s.direction, 1)
        self.assertLess(s.stop, s.entry)
        self.assertGreater(s.tp1, s.entry)          # alvo na direção da tendência
        self.assertGreaterEqual(s.rr1, C.min_rr1)
        self.assertIn("tendência", s.why)           # justificação legível

    def test_downtrend_fresh_low_is_chasing(self):
        # Escada descendente a terminar EM mínimo novo → recusa: perseguir.
        setups, rej = gate_trend_pullback(synth_staircase(up=False))
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("perseguir" in m for m in rej), rej)

    def test_uptrend_far_from_support_no_entry_zone(self):
        # Pullback a meio, longe de qualquer nível testado → sem zona de entrada.
        segs = STAIRCASE_UP[:-4] + [(112, 126, 14), (126, 122.5, 4)]
        setups, rej = gate_trend_pullback(synth_staircase(segs=segs))
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("longe do suporte" in m for m in rej), rej)

    def test_flat_range_no_trend_is_patience(self):
        # O range lateral — o trade que a v1 fazia (e perdia) — agora é recusado.
        setups, rej = gate_trend_pullback(synth_range(end_frac=0.03))
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("sem tendência" in m for m in rej), rej)

    def test_funding_veto_blocks_crowded_side(self):
        # Setup válido mas funding extremo do lado LONG → veto de posicionamento.
        setups, rej = gate_trend_pullback(synth_staircase(up=True), funding_z=2.5)
        self.assertEqual(len(setups), 0)
        self.assertTrue(any("sobrelotado" in m for m in rej), rej)

    def test_cost_floor_enforced(self):
        s = gate_trend_pullback(synth_staircase(up=True))[0][0]
        cost_floor_pct = C.cost_floor_mult * C.cost_rt()
        self.assertGreaterEqual(s.stop_pct + 1e-9, cost_floor_pct)

    def test_distinct_rejection_reasons(self):
        r1 = gate_trend_pullback(synth_staircase(up=False))[1][0]
        r2 = gate_trend_pullback(synth_range(end_frac=0.03))[1][0]
        r3 = gate_trend_pullback(synth_staircase(up=True), funding_z=2.5)[1][0]
        self.assertEqual(len({r1, r2, r3}), 3)


class TestNonOverlapEngine(unittest.TestCase):
    def test_trades_do_not_overlap(self):
        # Série longa: rampa de aquecimento + escada com pullback prolongado no fim.
        segs = ([(60, 80, 160)] + STAIRCASE_UP[:-1] + [(119, 119.15, 20)])
        k = synth_staircase(segs=segs)
        cfg = replace(C, val_horizon=4)
        res = evaluate_symbol(k, cfg, random.Random(1), strategy="v2")
        self.assertGreaterEqual(len(res["gate"]), 1)     # o motor encontra o setup
        ends = -1
        for t in res["gate"]:                            # não-sobreposição estrita
            self.assertGreater(t["i"], ends)
            ends = t["i"] + t["dur"]


if __name__ == "__main__":
    unittest.main()
