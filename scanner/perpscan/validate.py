"""Fase 3 — validação (secção 8 do framework).

Corre a estratégia escolhida (v2 = pullback com a tendência; v1 = reversão nos
extremos, REJEITADA, mantida para comparação) em walk-forward sobre história,
avalia cada setup por barreira tripla líquida de custos com trades
NÃO-SOBREPOSTAS, e compara com um baseline de controlo (entradas aleatórias,
mesmos símbolos/horas, mesma distância de stop, mesmo alvo em R, também sem
sobreposição).

Critérios de aprovação (pré-comprometidos, secção 8):
  A. distingue-se do aleatório (Welch p < 0.05 e média superior);
  B. expectância média > 0 (líquida de custos) — bater o acaso não chega;
  C. média positiva em ≥2 de 3 sub-períodos (consistência, não sorte de janela).

Uso (no teu computador, com `requests` instalado):

    python -m perpscan.validate --universe 50 --months 6          # v2 (default)
    python -m perpscan.validate --strategy v1 --universe 50 --months 6

Modo offline (sem rede, dados sintéticos — prova o harness, não valida o gate):

    python -m perpscan.validate --demo
"""
from __future__ import annotations

import argparse
import bisect
import random
from collections import deque
from statistics import mean, median
from typing import Dict, List, Optional, Tuple

from .backtest import stddev, summary, trailing_exit, triple_barrier_ex, welch
from dataclasses import replace

from .config import Config, DEFAULT
from .gates import gate_structure, gate_trend_pullback
from .triage import triage, universe_quality
from .features import precompute_features, features_at
from .structure import Klines

TF_MIN = {"1": 1, "3": 3, "5": 5, "15": 15, "30": 30, "60": 60,
          "120": 120, "240": 240, "360": 360, "720": 720, "D": 1440}


# ── Pré-cálculos O(N) por símbolo (para o pré-filtro barato por barra) ─────────
def _roll_extreme(vals: List[float], w: int, is_max: bool) -> List[float]:
    out = [0.0] * len(vals)
    dq: deque = deque()
    for i, v in enumerate(vals):
        while dq and ((vals[dq[-1]] <= v) if is_max else (vals[dq[-1]] >= v)):
            dq.pop()
        dq.append(i)
        if dq[0] <= i - w:
            dq.popleft()
        out[i] = vals[dq[0]]
    return out


def _precompute(k: Klines, cfg: Config) -> dict:
    N = len(k.c)
    atr = [0.0] * N
    if N > cfg.atr_n:
        trs = [0.0] * N
        for i in range(1, N):
            trs[i] = max(k.h[i] - k.l[i], abs(k.h[i] - k.c[i - 1]), abs(k.l[i] - k.c[i - 1]))
        a = sum(trs[1:cfg.atr_n + 1]) / cfg.atr_n
        atr[cfg.atr_n] = a
        for i in range(cfg.atr_n + 1, N):
            a = (a * (cfg.atr_n - 1) + trs[i]) / cfg.atr_n
            atr[i] = a
    cs = [0.0] * (N + 1)
    for i, v in enumerate(k.c):
        cs[i + 1] = cs[i] + v

    def sma_at(i: int, n: int) -> Optional[float]:
        return (cs[i + 1] - cs[i + 1 - n]) / n if i + 1 >= n else None

    return {
        "atr": atr, "sma_at": sma_at,
        "hi_r": _roll_extreme(k.h, cfg.range_lookback, True),
        "lo_r": _roll_extreme(k.l, cfg.range_lookback, False),
        "hi_p": _roll_extreme(k.h, cfg.pullback_lookback, True),
        "lo_p": _roll_extreme(k.l, cfg.pullback_lookback, False),
    }


def _prefilter_v2(k: Klines, pre: dict, i: int, cfg: Config) -> bool:
    """Condições baratas da v2 (tendência + pullback); o resto decide o gate."""
    a = pre["atr"][i]
    if not a > 0:
        return False
    sn = pre["sma_at"](i, cfg.trend_sma)
    st = pre["sma_at"](i - cfg.trend_slope_bars, cfg.trend_sma)
    if sn is None or st is None:
        return False
    slope, thr, px = sn - st, cfg.trend_slope_atr * a, k.c[i]
    if slope > thr and px > sn:
        depth = pre["hi_p"][i] - px
    elif slope < -thr and px < sn:
        depth = px - pre["lo_p"][i]
    else:
        return False
    return depth >= cfg.pullback_min_atr * a


def _prefilter_v1(k: Klines, pre: dict, i: int, cfg: Config) -> bool:
    hi, lo, px = pre["hi_r"][i], pre["lo_r"][i], k.c[i]
    span = hi - lo
    if not span > 0:
        return False
    pos = (px - lo) / span
    return pos <= cfg.dead_lo or pos >= cfg.dead_hi


def _funding_z_at(fund_ts: List[int], fund_rate: List[float],
                  t_bar: float, cfg: Config) -> Optional[float]:
    """z-score do funding point-in-time (só observações com ts ≤ t_bar)."""
    idx = bisect.bisect_right(fund_ts, t_bar) - 1
    if idx + 1 < cfg.funding_min_obs:
        return None
    lo = max(0, idx - cfg.funding_z_window + 1)
    win = fund_rate[lo:idx + 1]
    cur, hist = win[-1], win[:-1]
    sd = stddev(hist)
    return (cur - mean(hist)) / sd if sd > 0 else 0.0


def _oi_change_at(oi_ts: List[int], oi_v: List[float], t_bar: float,
                  back: int = 6) -> Optional[float]:
    """Variação % do open interest nas últimas `back` observações, point-in-time."""
    idx = bisect.bisect_right(oi_ts, t_bar) - 1
    if idx < back:
        return None
    prev = oi_v[idx - back]
    if not prev:
        return None
    return (oi_v[idx] - prev) / prev * 100.0


# ── Avaliação de um símbolo: walk-forward, trades não-sobrepostas ──────────────
def evaluate_symbol(k: Klines, cfg: Config, rng: random.Random, strategy: str = "v2",
                    funding: Optional[Tuple[List[int], List[float]]] = None,
                    i_from: Optional[int] = None, i_to: Optional[int] = None,
                    use_triage: bool = True, collect_features: bool = False,
                    oi: Optional[Tuple[List[int], List[float]]] = None) -> dict:
    N = len(k.c)
    w = cfg.analysis_window
    warm = max(w, cfg.trend_sma + cfg.trend_slope_bars + 2,
               cfg.range_lookback + cfg.atr_n + 2)
    last = N - cfg.val_horizon - 1
    empty = {"gate": [], "base": [], "decisions": 0, "cut": 0}
    if i_to is not None:
        last = min(last, i_to)
    start = warm if i_from is None else max(warm, i_from)
    if last <= start:
        return empty
    warm = start
    pre = _precompute(k, cfg)
    feats = precompute_features(k, cfg.val_tf) if collect_features else None
    prefilter = _prefilter_v2 if strategy == "v2" else _prefilter_v1
    cost = cfg.cost_rt()
    span_len = last - warm

    gate_trades: List[dict] = []          # {i, r, dur, stop_pct, third}
    decisions = 0
    cut = 0
    i = warm
    while i < last:
        if not prefilter(k, pre, i, cfg):
            i += 1
            continue
        win = Klines(o=k.o[i + 1 - w:i + 1], h=k.h[i + 1 - w:i + 1],
                     l=k.l[i + 1 - w:i + 1], c=k.c[i + 1 - w:i + 1],
                     v=k.v[i + 1 - w:i + 1],
                     t=k.t[i + 1 - w:i + 1] if k.t else [])
        if strategy == "v2":
            fz = (_funding_z_at(funding[0], funding[1], k.t[i], cfg)
                  if (funding and k.t) else None)
            setups, _ = gate_trend_pullback(win, cfg, funding_z=fz)
        else:
            setups, _ = gate_structure(win, cfg)
        if not setups:
            i += 1
            continue
        s = setups[0]
        if use_triage:
            ok, _cuts = triage(win, s.direction, cfg)
            if not ok:
                cut += 1
                i += 1
                continue
        decisions += 1
        if cfg.exit_mode == "trail":
            r, dur = trailing_exit(k.h[i + 1:], k.l[i + 1:], k.c[i + 1:],
                                   s.entry, s.stop, s.direction, s.atr,
                                   cfg.trail_atr, cost, cfg.val_horizon)
        else:
            r, dur = triple_barrier_ex(k.h[i + 1:], k.l[i + 1:], k.c[i + 1:],
                                       s.entry, s.stop,
                                       s.tp2 if cfg.target == "tp2" else s.tp1,
                                       s.direction, cost, cfg.val_horizon)
        if r is None:
            i += 1
            continue
        fv = None
        if feats is not None:
            fv = features_at(feats, i, s.direction)
            fz2 = (_funding_z_at(funding[0], funding[1], k.t[i], cfg)
                   if (funding and k.t) else None)
            if fz2 is not None:
                fv["funding_z"] = fz2 * s.direction     # + = funding contra o trade
            if oi and k.t:
                oz = _oi_change_at(oi[0], oi[1], k.t[i])
                if oz is not None:
                    fv["oi_chg_pct"] = oz
            fv["rr1"] = s.rr1
            fv["rr2"] = s.rr2
            fv["stop_pct"] = s.stop_pct
        gate_trades.append({"i": i, "r": r, "dur": dur, "stop_pct": s.stop_pct,
                            "features": fv,
                            "cost_r": cost / s.stop_pct,
                            "third": min(2, (i - warm) * 3 // max(1, span_len))})
        i += dur + 1                        # NÃO-SOBREPOSIÇÃO: retoma após o fecho

    # Baseline: mesmas horas, entradas/direções aleatórias, mesma distância de
    # stop (mediana dos aprovados), mesmo alvo em R — também sem sobreposição.
    stop_pcts = [t["stop_pct"] for t in gate_trades]
    med_stop = median(stop_pcts) if stop_pcts else 0.02
    target = len(gate_trades) * cfg.val_baseline_mult
    occupied = [False] * N
    base_trades: List[dict] = []
    attempts = 0
    while len(base_trades) < target and attempts < target * 30 + 100:
        attempts += 1
        j = rng.randint(warm, last - 1)
        if occupied[j]:
            continue
        entry = k.c[j]
        d = 1 if rng.random() < 0.5 else -1
        stop = entry * (1 - med_stop) if d > 0 else entry * (1 + med_stop)
        tp = (entry * (1 + med_stop * cfg.val_target_r) if d > 0
              else entry * (1 - med_stop * cfg.val_target_r))
        if cfg.exit_mode == "trail":
            r, dur = trailing_exit(k.h[j + 1:], k.l[j + 1:], k.c[j + 1:],
                                   entry, stop, d, pre["atr"][j] or (entry * med_stop),
                                   cfg.trail_atr, cost, cfg.val_horizon)
        else:
            r, dur = triple_barrier_ex(k.h[j + 1:], k.l[j + 1:], k.c[j + 1:],
                                       entry, stop, tp, d, cost, cfg.val_horizon)
        if r is None:
            continue
        span = range(j, min(j + dur + 1, N))
        if any(occupied[x] for x in span):
            continue
        for x in span:
            occupied[x] = True
        base_trades.append({"i": j, "r": r,
                            "third": min(2, (j - warm) * 3 // max(1, span_len))})

    return {"gate": gate_trades, "base": base_trades, "decisions": decisions,
            "cut": cut}


# ── Agregação e veredicto ──────────────────────────────────────────────────────
def run_validation(klines_by_symbol: Dict[str, Klines], cfg: Config = DEFAULT,
                   strategy: str = "v2",
                   funding_by_symbol: Optional[Dict[str, tuple]] = None,
                   split: str = "dev", use_triage: bool = True,
                   collect_features: bool = False,
                   oi_by_symbol: Optional[Dict[str, tuple]] = None) -> dict:
    rng = random.Random(cfg.seed)
    gate_all: List[float] = []
    base_all: List[float] = []
    thirds: List[List[float]] = [[], [], []]
    cost_rs: List[float] = []
    feature_records: List[Tuple[Dict[str, float], float]] = []
    decisions = 0
    cuts = 0
    total_bars = 0
    n_syms = len(klines_by_symbol)
    for n_done, (sym, k) in enumerate(klines_by_symbol.items(), 1):
        if len(k.c) < cfg.analysis_window + cfg.val_horizon + 20:
            continue
        fund = funding_by_symbol.get(sym) if funding_by_symbol else None
        # HOLDOUT: o corte é cronológico. Em 'dev' só se decide na parte antiga;
        # em 'holdout' só na parte final (que pode olhar para trás nos
        # indicadores — isso não é fuga, é o passado da própria decisão).
        n_bars = len(k.c)
        cut_i = int(n_bars * (1 - cfg.holdout_frac))
        if split == "dev":
            i_from, i_to = None, cut_i
        elif split == "holdout":
            i_from, i_to = cut_i, None
        else:
            i_from, i_to = None, None
        res = evaluate_symbol(k, cfg, rng, strategy, fund, i_from, i_to, use_triage,
                              collect_features,
                              oi_by_symbol.get(sym) if oi_by_symbol else None)
        for t in res["gate"]:
            if t.get("features"):
                # Estudo sobre o R BRUTO (antes de custos). O R líquido é
                # R_bruto − custo/stop_pct, o que ordena mecanicamente as trades
                # perdedoras pelo tamanho do stop e cria correlação falsa em
                # atr_pct/stop_pct. O bruto remove esse acoplamento.
                feature_records.append((t["features"], t["r"] + t["cost_r"]))
            gate_all.append(t["r"])
            cost_rs.append(t["cost_r"])
            thirds[t["third"]].append(t["r"])
        base_all.extend(t["r"] for t in res["base"])
        decisions += res["decisions"]
        cuts += res.get("cut", 0)
        total_bars += len(k.c)
        if n_syms >= 10:
            print(f"  avaliado {sym} ({n_done}/{n_syms}) — {len(res['gate'])} trades"
                  f"{', %d cortados' % res.get('cut', 0) if res.get('cut') else ''}",
                  flush=True)

    gate, base = summary(gate_all), summary(base_all)
    t, p = welch(gate_all, base_all)
    thirds_means = [mean(x) if x else None for x in thirds]
    thirds_pos = sum(1 for m in thirds_means if m is not None and m > 0)

    check_a = p < cfg.abandon_p and gate["mean"] > base["mean"]
    check_b = gate["mean"] > 0
    check_c = thirds_pos >= 2
    approved = check_a and check_b and check_c

    tf_min = TF_MIN.get(cfg.val_tf, 60)
    months_est = total_bars * tf_min / (60 * 24 * 30) / max(1, len(klines_by_symbol))
    trades_per_month = (gate["n"] / (months_est * max(1, len(klines_by_symbol)))
                        if months_est > 0 else 0.0)
    return {
        "strategy": strategy, "symbols": len(klines_by_symbol), "decisions": decisions,
        "gate": gate, "base": base, "t": t, "p": p,
        "thirds_means": thirds_means, "thirds_ns": [len(x) for x in thirds],
        "checks": {"a": check_a, "b": check_b, "c": check_c},
        "approved": approved, "months_est": months_est,
        "cost_r": mean(cost_rs) if cost_rs else 0.0,
        "cuts": cuts, "split": split, "triage": use_triage,
        "feature_records": feature_records,
        "trades_per_symbol_month": trades_per_month, "cfg": cfg,
    }


def format_report(res: dict) -> str:
    g, b, cfg = res["gate"], res["base"], res["cfg"]
    ck = res["checks"]
    ok = lambda x: "✓" if x else "✗"   # noqa: E731
    lines = []
    lines.append(f"Estratégia: {res['strategy']} · símbolos: {res['symbols']} · "
                 f"história ≈ {res['months_est']:.1f} meses/símbolo · "
                 f"TF {cfg.val_tf}m · saída {cfg.exit_mode}/{cfg.target} · "
                 f"horizonte {cfg.val_horizon} barras")
    lines.append(f"Divisão: {res['split'].upper()}"
                 f"{' (últimos %d%% do histórico)' % round(cfg.holdout_frac * 100) if res['split'] == 'holdout' else ''}"
                 f" · triagem: {'LIGADA' if res['triage'] else 'desligada'}"
                 f"{' · cortados pela triagem: %d' % res['cuts'] if res['triage'] else ''}")
    lines.append(f"Decisões do gate: {res['decisions']} · trades (não-sobrepostas): "
                 f"{g['n']} (≈{res['trades_per_symbol_month']:.1f}/símbolo/mês) · "
                 f"baseline: {b['n']}")
    lines.append("")
    lines.append(f"{'Métrica (R, líq. de custos)':<30}{'Gate':>12}{'Aleatório':>12}")
    lines.append("-" * 54)
    lines.append(f"{'Nº de trades':<30}{g['n']:>12}{b['n']:>12}")
    lines.append(f"{'Média':<30}{g['mean']:>12.3f}{b['mean']:>12.3f}")
    lines.append(f"{'Mediana':<30}{g['median']:>12.3f}{b['median']:>12.3f}")
    lines.append(f"{'Desvio-padrão':<30}{g['std']:>12.3f}{b['std']:>12.3f}")
    lines.append(f"{'% positivos':<30}{g['pos']:>11.1f}%{b['pos']:>11.1f}%")
    lines.append("")
    cr = res["cost_r"]
    lines.append(f"Decomposição do gate:  bruto {g['mean'] + cr:+.3f} R  "
                 f"−  custos {cr:.3f} R  =  líquido {g['mean']:+.3f} R")
    if g['mean'] + cr > 0 >= g['mean']:
        lines.append("  → há vantagem BRUTA real; são os custos que a consomem toda.")
    lines.append("")
    tm = res["thirds_means"]
    tn = res["thirds_ns"]
    third_txt = " · ".join(
        f"{i + 1}º terço: {('—' if m is None else f'{m:+.3f}')} (n={n})"
        for i, (m, n) in enumerate(zip(tm, tn)))
    lines.append(f"Sub-períodos (média R): {third_txt}")
    lines.append(f"Welch: t = {res['t']:.2f}, p = {res['p']:.3e}")
    lines.append("")
    lines.append("Critérios pré-comprometidos (secção 8):")
    lines.append(f"  {ok(ck['a'])} A. Distingue-se do aleatório (p < {cfg.abandon_p} "
                 f"e média superior)")
    lines.append(f"  {ok(ck['b'])} B. Expectância média > 0 (bater o acaso não chega)")
    lines.append(f"  {ok(ck['c'])} C. Média positiva em ≥2 de 3 sub-períodos "
                 f"(consistência)")
    lines.append("")
    if res["approved"]:
        lines.append("VEREDICTO: APROVADO. Os três critérios passam — o gate tem edge")
        lines.append("mensurável, líquido de custos, e consistente entre sub-períodos.")
        lines.append("Pode seguir para a Fase 4 (camada de pressão + scanner + paper).")
    else:
        failed = [c for c, v in (("A", ck["a"]), ("B", ck["b"]), ("C", ck["c"])) if not v]
        lines.append(f"VEREDICTO: REPROVADO (falhou: {', '.join(failed)}).")
        lines.append("Pela regra definida à partida, NÃO se avança para a Fase 4 e NÃO se")
        lines.append("procuram parametrizações até 'funcionar' — isso é sobreajuste. O")
        lines.append("caminho é rever a HIPÓTESE com o detalhe acima (que critério falhou,")
        lines.append("em que sub-período) e testar a hipótese revista de novo.")
    return "\n".join(lines)


# ── Demo offline (random walks; esperado: REPROVADO) ───────────────────────────
def _demo_klines(cfg: Config, n_symbols: int = 20, n_bars: int = 900) -> Dict[str, Klines]:
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
        out[f"SYNTH{s}"] = Klines(o=o, h=h, l=l, c=c, v=[1.0] * n_bars,
                                  t=[float(i) for i in range(n_bars)])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Validação da camada de seleção (Fase 3).")
    ap.add_argument("--strategy", choices=["v1", "v2"], default="v2",
                    help="v2 = pullback com a tendência (default); v1 = reversão (rejeitada)")
    ap.add_argument("--universe", type=int, default=DEFAULT.val_universe)
    ap.add_argument("--tf", default=DEFAULT.val_tf)
    ap.add_argument("--months", type=float, default=None,
                    help="meses de história (paginado); ex. --months 6")
    ap.add_argument("--limit", type=int, default=DEFAULT.val_kline_limit,
                    help="barras por símbolo quando --months não é dado")
    ap.add_argument("--horizon", type=int, default=DEFAULT.val_horizon)
    ap.add_argument("--exit", choices=["tp", "trail"], default=None,
                    help="tp = barreiras limitadas (calibrada); trail = EXPERIMENTAL, não validada")
    ap.add_argument("--target", choices=["tp1", "tp2"], default=None,
                    help="tp1 = nível oposto mais próximo; tp2 = extremo da tendência (default)")
    ap.add_argument("--no-funding", action="store_true",
                    help="desliga o veto de funding (menos pedidos à API)")
    ap.add_argument("--exclude", default="",
                    help="baseCoins extra a excluir, ex. --exclude ABC,XYZ")
    ap.add_argument("--split", choices=["dev", "holdout", "all"], default="dev",
                    help="dev = primeiros 70%% (default); holdout = últimos 30%%, "
                         "UMA ÚNICA VEZ; all = tudo")
    ap.add_argument("--confirmo-holdout", action="store_true",
                    help="obrigatório para abrir o holdout — é irreversível")
    ap.add_argument("--estudo", action="store_true",
                    help="mede cada indicador contra o R realizado (só em DEV)")
    ap.add_argument("--with-oi", action="store_true",
                    help="inclui open interest no estudo (mais pedidos à API)")
    ap.add_argument("--no-triage", action="store_true",
                    help="desliga a camada de triagem (para comparar)")
    ap.add_argument("--demo", action="store_true", help="dados sintéticos, sem rede")
    ap.add_argument("--list-universe", action="store_true",
                    help="diagnóstico: mostra o universo devolvido pela Bybit e sai")
    args = ap.parse_args()

    if args.list_universe:
        from . import bybit
        raw = bybit._get("/v5/market/tickers", {"category": "linear"})
        lst = raw.get("result", {}).get("list", [])
        print(f"Símbolos devolvidos pela API: {len(lst)}")
        print(f"nextPageCursor: {raw.get('result', {}).get('nextPageCursor', '(nenhum)')!r}")
        usdt = [t for t in lst if t["symbol"].endswith("USDT")]
        print(f"Pares USDT: {len(usdt)}")
        vals = []
        for t in usdt:
            try:
                vals.append((float(t.get("turnover24h") or 0), t["symbol"]))
            except (TypeError, ValueError):
                vals.append((0.0, t["symbol"] + " (turnover ilegível)"))
        vals.sort(reverse=True)
        print(f"Com turnover ≥ 30M: {sum(1 for v, _ in vals if v >= 30e6)}")
        print(f"Com turnover = 0 ou ilegível: {sum(1 for v, _ in vals if v <= 0)}")
        print("\nTop 30 por turnover 24h:")
        for v, s in vals[:30]:
            print(f"  {s:<16} {v/1e6:>12,.1f}M")
        return

    if args.split == "holdout" and not args.confirmo_holdout:
        print("RECUSADO: o holdout são os últimos 30% do histórico, guardados para\n"
              "UM ÚNICO teste final. Abrir e voltar a afinar destrói o seu valor —\n"
              "passa a ser mais um conjunto de treino e deixamos de saber se a\n"
              "estratégia funciona ou se foi moldada aos dados.\n\n"
              "Se é mesmo o teste final, repete com --confirmo-holdout.")
        return

    tf_min = TF_MIN.get(args.tf, 60)
    bars = int(args.months * 30 * 24 * 60 / tf_min) if args.months else args.limit
    cfg = Config(val_tf=args.tf, val_kline_limit=bars, val_horizon=args.horizon,
                 val_universe=args.universe)
    if args.exit:
        cfg = replace(cfg, exit_mode=args.exit)
    if args.target:
        cfg = replace(cfg, target=args.target)
    if cfg.exit_mode == "trail":
        print("AVISO: saída 'trail' NÃO está calibrada (inventa lucro em martingala).\n"
              "       Os números que saírem daqui não servem para decidir nada.\n")

    if args.estudo and args.split != "dev":
        print("RECUSADO: o estudo de features é exploratório e só corre em DEV.\n"
              "Explorar 20 indicadores no holdout queimava-o sem nada em troca.")
        return

    funding_by_symbol: Optional[Dict[str, tuple]] = None
    oi_by_symbol: Optional[Dict[str, tuple]] = None
    if args.demo:
        print("MODO DEMO — random walks sintéticos (sem rede). Esperado REPROVADO: "
              "valida o harness e o veredicto, não o gate.\n")
        klines = _demo_klines(cfg)
    else:
        from . import bybit  # import tardio (rede)
        exclude = set(cfg.denylist_base) | {s for s in args.exclude.upper().split(",") if s}
        print(f"A obter universo (top {cfg.val_universe} por turnover ≥ "
              f"{cfg.min_turnover / 1e6:.0f}M, só cripto)…", flush=True)
        uni, _full, removed = bybit.fetch_universe(cfg.min_turnover, cfg.val_universe, exclude)
        if removed:
            print(f"  excluídos (não-cripto): {', '.join(sorted(removed))}", flush=True)
        if len(uni) < args.universe:
            print(f"  aviso: só {len(uni)} pares cumprem o filtro de liquidez "
                  f"(pedidos {args.universe})", flush=True)
        klines = {}
        funding_by_symbol = {} if (args.strategy == "v2" and not args.no_funding) else None
        for i, m in enumerate(uni, 1):
            sym = m["symbol"]
            try:
                k = (bybit.fetch_kline_paged(sym, cfg.val_tf, bars) if bars > 1000
                     else bybit.fetch_kline(sym, cfg.val_tf, bars))
                okq, whyq = universe_quality(len(k.c), m["turnover"], cfg)
                if not okq:
                    print(f"  [{i}/{len(uni)}] {sym} — EXCLUÍDO: {whyq}", flush=True)
                    continue
                klines[sym] = k
                extra = ""
                if funding_by_symbol is not None and k.t:
                    funding_by_symbol[sym] = bybit.fetch_funding_paged(sym, k.t[0])
                    extra = f" + {len(funding_by_symbol[sym][0])} fundings"
                if args.with_oi and args.estudo:
                    if oi_by_symbol is None:
                        oi_by_symbol = {}
                    oi_by_symbol[sym] = bybit.fetch_oi_paged(sym, cfg.val_tf, bars)
                    extra += f" + {len(oi_by_symbol[sym][0])} OI"
                print(f"  [{i}/{len(uni)}] {sym} — {len(k.c)} barras{extra}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"  [{i}/{len(uni)}] {sym} — falhou: {e}", flush=True)

    if args.split == "holdout":
        print("\n*** TESTE FINAL NO HOLDOUT — resultado definitivo, sem repetições ***\n", flush=True)
    print("A correr walk-forward + baseline (trades não-sobrepostas)…", flush=True)
    print("(esta é a parte pesada — num tablet pode levar vários minutos por símbolo)\n",
          flush=True)
    res = run_validation(klines, cfg, args.strategy, funding_by_symbol,
                         split=args.split, use_triage=not args.no_triage,
                         collect_features=args.estudo, oi_by_symbol=oi_by_symbol)
    print()
    print(format_report(res))
    if args.estudo:
        from .study import analyse, format_study
        recs = res["feature_records"]
        print()
        print("=" * 82)
        if len(recs) < 60:
            print(f"Amostra insuficiente para o estudo ({len(recs)} trades). "
                  f"Aumenta --universe ou --months.")
        else:
            print(format_study(analyse(recs), len(recs)))


if __name__ == "__main__":
    main()
