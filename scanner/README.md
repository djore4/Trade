# perpscan — camada estrutural (Python)

Porta em Python da camada de seleção estrutural do screener de perpétuos USDT da
Bybit. É o **harness de backtesting** que a prompt pede e que a app browser não
consegue correr a sério: decide que pares têm um trade utilizável (Gate 0 +
Gate 1) e **valida** se o gate se distingue do acaso, líquido de custos.

Especificação: [`../framework-trading-perpetuos.md`](../framework-trading-perpetuos.md)
(secções 5, 6, 8, 9). O código e o documento são espelho um do outro.

## Estrutura

```
scanner/
  perpscan/
    config.py      # limiares (Apêndice A do framework); [SUP] = a ratificar
    structure.py   # Fase 1 — atr, swing_pivots, cluster_levels, range_bounds (puros)
    gates.py       # Fase 2 — gate_liquidity (Gate 0) + gate_structure (Gate 1), binários
    backtest.py    # Fase 3 — triple_barrier, welch, sumários
    validate.py    # Fase 3 — walk-forward + baseline aleatório + veredicto (CLI)
    bybit.py       # cliente REST Bybit v5 (única camada com rede; requer requests)
    synth.py       # séries sintéticas para testes
  tests/           # unittest (também compatível com pytest)
```

## Requisitos

- Python ≥ 3.10. O núcleo **não precisa de dependências** (só stdlib).
- Para ir buscar dados reais à Bybit: `pip install -r requirements.txt` (apenas
  `requests`).

## Correr os testes (sem rede)

```bash
cd scanner
python -m unittest discover -s tests -v
# ou, se tiveres pytest:  pytest -q
```

## Fase 3 — validação

**Offline (sem rede, prova o harness):**

```bash
cd scanner
python -m perpscan.validate --demo
```

Usa random walks sintéticos. O resultado esperado é **NÃO-significativo** — é
suposto: em dados sem edge, o critério de abandono tem de disparar. Serve para
confirmar que o harness e o veredicto funcionam.

**Real (no teu computador, com acesso à Bybit):**

```bash
cd scanner
pip install -r requirements.txt
python -m perpscan.validate --universe 50 --tf 60 --limit 1000
```

Isto:
1. vai buscar os 50 pares mais líquidos (turnover ≥ 30M);
2. puxa ~1000 klines TF60 de cada;
3. corre `gate_structure` em **walk-forward** (sem look-ahead);
4. avalia cada setup por **barreira tripla líquida de custos**;
5. constrói o **baseline aleatório** (mesmos símbolos/horas, mesma distância de
   stop, mesmo alvo em R);
6. imprime as duas distribuições de R e o **veredicto** do critério de abandono
   (secção 8): se `p ≥ 0.05` ou a média não for superior, o gate é cosmético e
   **não se avança para a Fase 4**.

> Nota sobre "6 meses": 1000 barras de TF60 ≈ 42 dias. Para ≥ 6 meses de história,
> aumenta `--limit` (a Bybit lima a 1000 por pedido — a paginação por
> `start/end` é o próximo passo natural em `bybit.py`) ou usa um TF maior.

## O que falta (próximos passos da componente Python)

- Paginação de klines para history longa (≥ 6 meses) em `bybit.py`.
- Portar a camada de pressão (H1–H4) e a pontuação qualitativa (secção 7) — só
  **depois** da Fase 3 passar.
- Paper trader / walk-forward contínuo e kill-switch (secção 9).
