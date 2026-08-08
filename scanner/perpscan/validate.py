"""Fase 3 — validação (secção 8 do framework).

Corre `gate_structure` em walk-forward sobre história, avalia cada setup aprovado
por barreira tripla líquida de custos, e compara com um baseline de controlo
(entradas aleatórias, mesmos símbolos/horas, mesma distância de stop, mesmo alvo
em R). Imprime as distribuições de R e o veredicto do critério de abandono.

Uso (no teu computador, com `requests` instalado):

    python -m perpscan.validate --universe 50 --tf 60 --limit 1000

Modo offline (sem rede, dados sintéticos — prova o harness, não valida o gate):

    python -m perpscan.validate --demo
"""
from __future__ import annotations

import argparse
import random
from typing import Callable, Dict, List, Tuple

from .backtest import summary, triple_barrier, welch
from .config import Config, DEFAULT
from .gates import gate_structure
from .structure import Klines


def _window(k: Klines, end: int) -> Klines:
    return Klines(o=k.o[:end], h=k.h[:end], l=k.l[:end], c=k.c[:end], v=k.v[:end])


def evaluate_symbol(k: Klines, cfg: Config, rng: random.Random) -> Tuple[List[float], List[float], int]:
    """Devolve (gate_Rs, baseline_Rs, nº de decisões do gate) para um símbolo."""
    N = len(k)
    warm = max(cfg.range_lookback, cfg.atr_n + cfg.pivot_left + cfg.pivot_right + 5)
    cost = cfg.cost_rt()
    gate_rs: List[float] = []
    stop_pcts: List[float] = []
    decisions = 0

    last = N - cfg.val_horizon - 1
    for i in range(warm, last):
        setups, _ = gate_structure(_window(k, i + 1), cfg)
        if not setups:
            continue
        decisions += 1
        s = setups[0]
        r = triple_barrier(k.h[i + 1:], k.l[i + 1:], k.c[i + 1:],
                           s.entry, s.stop, s.tp1, s.direction, cost, cfg.val_horizon)
        if r is not None:
            gate_rs.append(r)
            stop_pcts.append(s.stop_pct)

    # Baseline: mesmas horas, entradas/direções aleatórias, MESMA distância de stop
    # (mediana dos aprovados) e MESMO alvo em R.
    med_stop = sorted(stop_pcts)[len(stop_pcts) // 2] if stop_pcts else 0.02
    base_rs: List[float] = []
    n_base = min(len(gate_rs) * cfg.val_baseline_mult, 400)
    for _ in range(n_base):
        if last - 1 <= warm:
            break
        i = rng.randint(warm, last - 1)
        entry = k.c[i]
        direction = 1 if rng.random() < 0.5 else -1
        stop = entry * (1 - med_stop) if direction > 0 else entry * (1 + med_stop)
        tp = entry * (1 + med_stop * cfg.val_target_r) if direction > 0 \
            else entry * (1 - med_stop * cfg.val_target_r)
        r = triple_barrier(k.h[i + 1:], k.l[i + 1:], k.c[i + 1:],
                           entry, stop, tp, direction, cost, cfg.val_horizon)
        if r is not None:
            base_rs.append(r)
    return gate_rs, base_rs, decisions


def run_validation(klines_by_symbol: Dict[str, Klines], cfg: Config = DEFAULT) -> dict:
    """Corre a validação sobre um conjunto de séries já obtidas."""
    rng = random.Random(cfg.seed)
    gate_all: List[float] = []
    base_all: List[float] = []
    decisions = 0
    for _sym, k in klines_by_symbol.items():
        if len(k) < cfg.range_lookback + cfg.val_horizon + 20:
            continue
        g, b, d = evaluate_symbol(k, cfg, rng)
        gate_all += g
        base_all += b
        decisions += d

    gate = summary(gate_all)
    base = summary(base_all)
    t, p = welch(gate_all, base_all)
    significant = (p < cfg.abandon_p) and (gate["mean"] > base["mean"])
    return {
        "symbols": len(klines_by_symbol), "decisions": decisions,
        "gate": gate, "base": base, "t": t, "p": p, "significant": significant, "cfg": cfg,
    }


def format_report(res: dict) -> str:
    g, b, cfg = res["gate"], res["base"], res["cfg"]
    lines = []
    lines.append(f"Símbolos: {res['symbols']} · decisões do gate: {res['decisions']} · "
                 f"trades avaliados: {g['n']} · baseline: {b['n']} · "
                 f"TF {cfg.val_tf}m · horizonte {cfg.val_horizon} barras")
    lines.append("")
    lines.append(f"{'Métrica (R, líq. de custos)':<30}{'Gate':>12}{'Aleatório':>12}")
    lines.append("-" * 54)
    lines.append(f"{'Nº de trades':<30}{g['n']:>12}{b['n']:>12}")
    lines.append(f"{'Média':<30}{g['mean']:>12.3f}{b['mean']:>12.3f}")
    lines.append(f"{'Mediana':<30}{g['median']:>12.3f}{b['median']:>12.3f}")
    lines.append(f"{'Desvio-padrão':<30}{g['std']:>12.3f}{b['std']:>12.3f}")
    lines.append(f"{'% positivos':<30}{g['pos']:>11.1f}%{b['pos']:>11.1f}%")
    lines.append("")
    lines.append(f"Welch: t = {res['t']:.2f}, p = {res['p']:.3e}")
    lines.append("")
    if res["significant"]:
        lines.append("VEREDICTO: ESTATISTICAMENTE SIGNIFICATIVO. Os setups distinguem-se do")
        lines.append("baseline aleatório (p < %.2f e média de R superior). O gate NÃO é" % cfg.abandon_p)
        lines.append("cosmético — pode seguir para a Fase 4.")
    else:
        extra = "" if res["gate"]["mean"] > res["base"]["mean"] else " (a média de R nem é superior)"
        lines.append("VEREDICTO: NÃO SIGNIFICATIVO — CRITÉRIO DE ABANDONO.")
        lines.append(f"Os setups NÃO se distinguem do baseline aleatório (p ≥ {cfg.abandon_p}){extra}.")
        lines.append("Pela regra definida à partida, o gate é cosmético e NÃO se avança para a")
        lines.append("Fase 4. Não procurar parametrizações alternativas até 'funcionar' — sobreajuste.")
    return "\n".join(lines)


def _demo_klines(cfg: Config, n_symbols: int = 20, n_bars: int = 600) -> Dict[str, Klines]:
    """Random walks sintéticos (sem rede). Esperado: NÃO-significativo — prova o
    harness e o critério de abandono a disparar corretamente em dados sem edge."""
    rng = random.Random(cfg.seed)
    out: Dict[str, Klines] = {}
    for s in range(n_symbols):
        px = 100.0
        o, h, l, c = [], [], [], []
        for _ in range(n_bars):
            drift = rng.gauss(0, 1.0)
            nxt = max(1.0, px + drift)
            hi = max(px, nxt) + abs(rng.gauss(0, 0.4))
            lo = min(px, nxt) - abs(rng.gauss(0, 0.4))
            o.append(px); c.append(nxt); h.append(hi); l.append(lo)
            px = nxt
        out[f"SYNTH{s}"] = Klines(o=o, h=h, l=l, c=c, v=[1.0] * n_bars)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Validação da camada estrutural (Fase 3).")
    ap.add_argument("--universe", type=int, default=DEFAULT.val_universe)
    ap.add_argument("--tf", default=DEFAULT.val_tf)
    ap.add_argument("--limit", type=int, default=DEFAULT.val_kline_limit)
    ap.add_argument("--horizon", type=int, default=DEFAULT.val_horizon)
    ap.add_argument("--demo", action="store_true", help="dados sintéticos, sem rede")
    args = ap.parse_args()

    cfg = Config(val_tf=args.tf, val_kline_limit=args.limit, val_horizon=args.horizon,
                 val_universe=args.universe)

    if args.demo:
        print("MODO DEMO — random walks sintéticos (sem rede). "
              "Esperado NÃO-significativo: valida o harness, não o gate.\n")
        klines = _demo_klines(cfg)
    else:
        from . import bybit  # import tardio (rede)
        print(f"A obter universo (top {cfg.val_universe} por turnover ≥ "
              f"{cfg.min_turnover/1e6:.0f}M)…")
        uni, _full = bybit.fetch_universe(cfg.min_turnover, cfg.val_universe)
        klines = {}
        for i, m in enumerate(uni, 1):
            try:
                klines[m["symbol"]] = bybit.fetch_kline(m["symbol"], cfg.val_tf, cfg.val_kline_limit)
                print(f"  [{i}/{len(uni)}] {m['symbol']}")
            except Exception as e:  # noqa: BLE001
                print(f"  [{i}/{len(uni)}] {m['symbol']} — falhou: {e}")

    print("\nA correr walk-forward + baseline…\n")
    res = run_validation(klines, cfg)
    print(format_report(res))


if __name__ == "__main__":
    main()
