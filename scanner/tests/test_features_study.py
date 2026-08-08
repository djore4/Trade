"""Bateria de indicadores e estudo de features."""
import random
import unittest

from perpscan.features import (BARS_PER_WEEK, bollinger_series, features_at,
                               macd_series, precompute_features, rsi_series)
from perpscan.structure import Klines
from perpscan.study import analyse, benjamini_hochberg, spearman
from perpscan.synth import synth_trend


def _walk(n, seed, drift=0.0):
    r = random.Random(seed)
    px = 100.0
    o, h, l, c, v = [], [], [], [], []
    for _ in range(n):
        a = px
        px = max(1.0, px * (1 + r.gauss(drift, 0.01)))
        o.append(a); c.append(px)
        h.append(max(a, px) * 1.002); l.append(min(a, px) * 0.998)
        v.append(abs(r.gauss(1000, 200)))
    return Klines(o=o, h=h, l=l, c=c, v=v, t=[float(i) for i in range(n)])


class TestIndicatorSeries(unittest.TestCase):
    def test_rsi_series_matches_direction(self):
        s = rsi_series(synth_trend().c, 14)
        self.assertGreater(s[-1], 90)                     # só ganhos

    def test_macd_hist_is_line_minus_signal(self):
        c = _walk(300, 1).c
        line, sig, hist = macd_series(c)
        for i in range(len(c)):
            if hist[i] is not None:
                self.assertAlmostEqual(hist[i], line[i] - sig[i], places=9)

    def test_bollinger_pctb_within_band(self):
        pctb, width = bollinger_series(_walk(300, 2).c, 20, 2.0)
        vals = [x for x in pctb if x is not None]
        self.assertTrue(vals)
        self.assertTrue(all(-1.5 < x < 2.5 for x in vals))   # %B tem escala sã
        self.assertTrue(all(w >= 0 for w in width if w is not None))

    def test_no_lookahead_in_any_feature(self):
        """O valor na barra i não pode mudar se o futuro for alterado."""
        k = _walk(600, 3)
        i = 400
        base = precompute_features(k, "240")
        k2 = Klines(o=list(k.o), h=list(k.h), l=list(k.l), c=list(k.c),
                    v=list(k.v), t=list(k.t))
        for j in range(i + 1, len(k2.c)):
            k2.c[j] *= 5.0; k2.h[j] *= 5.0; k2.l[j] *= 5.0; k2.v[j] *= 5.0
        after = precompute_features(k2, "240")
        for name in base:
            a, b = base[name][i], after[name][i]
            if a is None or b is None:
                self.assertEqual(a, b, f"{name}: presença mudou com o futuro")
            else:
                self.assertAlmostEqual(a, b, places=9, msg=f"{name} usa o futuro")

    def test_directional_features_flip_with_short(self):
        k = _walk(600, 4)
        f = precompute_features(k, "240")
        lo = features_at(f, 500, 1)
        sh = features_at(f, 500, -1)
        self.assertAlmostEqual(lo["mom_24"], -sh["mom_24"], places=9)
        self.assertAlmostEqual(lo["rsi14"], 100.0 - sh["rsi14"], places=9)
        self.assertAlmostEqual(lo["atr_pct"], sh["atr_pct"], places=9)   # não-direcional

    def test_bars_per_week_covers_used_timeframes(self):
        for tf in ("60", "240", "D"):
            self.assertIn(tf, BARS_PER_WEEK)


class TestStats(unittest.TestCase):
    def test_spearman_monotonic(self):
        x = list(range(50))
        self.assertAlmostEqual(spearman(x, [v * 3 for v in x]), 1.0, places=6)
        self.assertAlmostEqual(spearman(x, [-v for v in x]), -1.0, places=6)

    def test_spearman_handles_ties(self):
        self.assertAlmostEqual(spearman([1, 1, 1, 1], [1, 2, 3, 4]), 0.0)

    def test_bh_rejects_when_all_null(self):
        self.assertEqual(benjamini_hochberg([0.4, 0.6, 0.9, 0.5], 0.10), [False] * 4)

    def test_bh_keeps_strong_signal(self):
        keep = benjamini_hochberg([1e-8] + [0.5] * 19, 0.10)
        self.assertTrue(keep[0])
        self.assertFalse(any(keep[1:]))


class TestStudyControls(unittest.TestCase):
    def test_negative_control_no_feature_survives(self):
        """Features aleatórias vs R aleatório: nada pode sobreviver."""
        r = random.Random(9)
        recs = [({f"f{j}": r.gauss(0, 1) for j in range(15)}, r.gauss(0, 1))
                for _ in range(400)]
        res = analyse(recs)
        self.assertEqual(res["n_survive"], 0)

    @staticmethod
    def _with_signal(seed: int, n: int = 400, strength: float = 1.2):
        r = random.Random(seed)
        recs = []
        for _ in range(n):
            good = r.gauss(0, 1)
            feats = {"sinal": good}
            feats.update({f"ruido{j}": r.gauss(0, 1) for j in range(14)})
            recs.append((feats, good * strength + r.gauss(0, 1)))
        return recs

    def test_positive_control_real_predictor_is_detected(self):
        """Uma feature que realmente prevê o R tem de ser detetada, e no topo."""
        for seed in (10, 11, 12):
            res = analyse(self._with_signal(seed))
            surv = [x["name"] for x in res["rows"] if x["survives"]]
            self.assertIn("sinal", surv, f"seed {seed}: sinal real não detetado")
            self.assertEqual(res["rows"][0]["name"], "sinal",
                             f"seed {seed}: sinal real não ficou no topo")

    def test_false_discovery_rate_is_controlled(self):
        """A proporção de falsas descobertas tem de rondar q, não ser livre.

        O BH não garante zero falsos positivos — garante que, em média, a
        fracção de descobertas erradas fica em torno de q. É isso que se mede
        aqui, e é a razão pela qual uma tabela de indicadores nunca deve ser
        lida como 'estes N funcionam'.
        """
        props = []
        for seed in range(20, 32):
            res = analyse(self._with_signal(seed))
            surv = [x["name"] for x in res["rows"] if x["survives"]]
            if surv:
                props.append(sum(1 for s in surv if s != "sinal") / len(surv))
        self.assertTrue(props)
        self.assertLess(sum(props) / len(props), 0.35,
                        "taxa de falsas descobertas fora de controlo")


if __name__ == "__main__":
    unittest.main()
