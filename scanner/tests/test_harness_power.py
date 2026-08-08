"""Controlos do harness de validação.

Um veredicto só vale se a régua souber distinguir os dois casos:
  • CONTROLO POSITIVO — dados com momentum genuíno (o efeito que a v2 diz
    explorar): tem de APROVAR. Sem isto, um "REPROVADO" pode ser só uma régua
    que nunca aprova nada.
  • CONTROLO NEGATIVO — passeio aleatório (sem edge por construção): tem de
    REPROVAR. Sem isto, a régua aprovaria ruído.
"""
import random
import unittest
from statistics import mean

from perpscan.backtest import stddev
from perpscan.config import Config
from perpscan.structure import Klines
from perpscan.validate import run_validation


SUBSTEPS = 20          # passos intra-barra


def _series(n: int, seed: int, regime_len: int = 0, drifts=(0.0,),
            substeps: int = SUBSTEPS) -> Klines:
    """Série sintética com caminho INTRA-BARRA.

    Cada barra é composta por `substeps` micro-movimentos e não por um único
    salto. Isto importa: com barras de salto único o preço ultrapassa um stop
    em ~0.6% antes de ser detetado, e a convenção "o stop enche no nível" passa
    a valer ~+0.4 R por trade de lucro fictício — o controlo negativo aprovaria
    ruído. Com caminho intra-barra o excesso é pequeno, como num mercado
    líquido real.
    """
    r = random.Random(seed)
    px, drift = 100.0, drifts[0]
    sub_vol = 0.010 / (substeps ** 0.5)
    sub_drift = drift / substeps
    o, h, l, c, t = [], [], [], [], []
    for i in range(n):
        if regime_len and i % regime_len == 0:
            drift = r.choice(drifts)
            sub_drift = drift / substeps
        op = px
        hi = lo = px
        for _ in range(substeps):
            px = max(1.0, px * (1 + r.gauss(sub_drift, sub_vol)))
            hi = max(hi, px)
            lo = min(lo, px)
        o.append(op)
        c.append(px)
        h.append(hi)
        l.append(lo)
        t.append(float(i * 3_600_000))
    return Klines(o=o, h=h, l=l, c=c, v=[1.0] * n, t=t)


class TestHarnessPower(unittest.TestCase):
    def test_positive_control_momentum_is_approved(self):
        """Com tendências persistentes, a v2 tem de passar os três critérios."""
        ks = {f"TRND{s}": _series(1600, s, regime_len=220, drifts=(0.0022, -0.0018))
              for s in range(12)}
        res = run_validation(ks, Config(), "v2")
        self.assertGreater(res["gate"]["n"], 100, "amostra pequena demais para concluir")
        self.assertTrue(res["checks"]["a"], "não distinguiu do aleatório")
        self.assertTrue(res["checks"]["b"], f"expectância {res['gate']['mean']:.3f} ≤ 0")
        self.assertTrue(res["checks"]["c"], "inconsistente entre sub-períodos")
        self.assertTrue(res["approved"])

    def test_negative_control_random_walk_is_rejected(self):
        """Em passeio aleatório (sem edge) o veredicto tem de ser REPROVADO."""
        ks = {f"RW{s}": _series(1200, 100 + s) for s in range(12)}
        res = run_validation(ks, Config(), "v2")
        self.assertFalse(res["approved"])


class TestExitCalibration(unittest.TestCase):
    """Calibração da régua: numa MARTINGALA nenhum lucro é possível.

    Se E[preço futuro] = preço atual, qualquer regra de saída tem E[R] = 0 antes
    de custos. Uma regra que dê positivo aqui está a inventar dinheiro — por
    look-ahead ou por assumir execuções impossíveis. Este teste apanha isso
    ANTES de a regra ser usada para julgar uma estratégia.
    """

    @staticmethod
    def _martingale(n_bars: int, seed: int, substeps: int = SUBSTEPS):
        r = random.Random(seed)
        px = 100.0
        sv = 0.010 / (substeps ** 0.5)
        h, l, c = [], [], []
        for _ in range(n_bars):
            hi = lo = px
            for _ in range(substeps):
                px = px * (1 + r.gauss(0, sv))
                hi = max(hi, px)
                lo = min(lo, px)
            h.append(hi)
            l.append(lo)
            c.append(px)
        return h, l, c

    def test_triple_barrier_is_unbiased_on_martingale(self):
        from perpscan.backtest import triple_barrier_ex
        rs = []
        for s in range(4000):
            h, l, c = self._martingale(122, s)
            r, _ = triple_barrier_ex(h, l, c, 100.0, 98.64, 102.7, 1, 0.0, 120)
            if r is not None:
                rs.append(r)
        m = mean(rs)
        ci = 1.96 * stddev(rs) / len(rs) ** 0.5
        self.assertLess(abs(m), max(ci, 0.05),
                        f"barreira tripla enviesada em martingala: E[R]={m:+.4f} ±{ci:.4f}")


class TestNoLookahead(unittest.TestCase):
    def test_decision_uses_only_past_bars(self):
        """A decisão na barra i não pode mudar se o FUTURO for alterado."""
        from perpscan.gates import gate_trend_pullback
        k = _series(600, 42, regime_len=200, drifts=(0.002, -0.002))
        i = 400
        w = Config().analysis_window
        win = Klines(o=k.o[i + 1 - w:i + 1], h=k.h[i + 1 - w:i + 1],
                     l=k.l[i + 1 - w:i + 1], c=k.c[i + 1 - w:i + 1],
                     v=[1.0] * w, t=k.t[i + 1 - w:i + 1])
        before = gate_trend_pullback(win, Config())
        k2 = Klines(o=list(k.o), h=list(k.h), l=list(k.l), c=list(k.c),
                    v=list(k.v), t=list(k.t))
        for j in range(i + 1, len(k2.c)):          # destrói o futuro
            k2.c[j] *= 3.0
            k2.h[j] *= 3.0
            k2.l[j] *= 3.0
        win2 = Klines(o=k2.o[i + 1 - w:i + 1], h=k2.h[i + 1 - w:i + 1],
                      l=k2.l[i + 1 - w:i + 1], c=k2.c[i + 1 - w:i + 1],
                      v=[1.0] * w, t=k2.t[i + 1 - w:i + 1])
        after = gate_trend_pullback(win2, Config())
        self.assertEqual(len(before[0]), len(after[0]))
        if before[0]:
            self.assertAlmostEqual(before[0][0].entry, after[0][0].entry)
            self.assertAlmostEqual(before[0][0].stop, after[0][0].stop)


if __name__ == "__main__":
    unittest.main()
