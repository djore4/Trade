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

**Real (no teu computador, com acesso à Bybit) — o teste a sério:**

```bash
cd scanner
pip install -r requirements.txt
python -m perpscan.validate --universe 50 --months 6
```

Isto:
1. vai buscar os 50 pares de cripto mais líquidos (turnover ≥ 30M) — **exclui
   ações e metais tokenizados** (XAU, SOXL, SNDK…);
2. pagina **6 meses** de klines TF60 de cada, mais o histórico de funding;
3. corre a estratégia em **walk-forward** (sem look-ahead, funding
   point-in-time);
4. avalia cada setup por **barreira tripla líquida de custos**, com trades
   **não-sobrepostas**;
5. constrói o **baseline aleatório** (mesmos símbolos/horas, mesma distância de
   stop, mesmo alvo em R, também sem sobreposição);
6. imprime as distribuições de R, os **três sub-períodos**, e o veredicto dos
   **três critérios** da secção 8 (A: bate o acaso · B: expectância > 0 ·
   C: consistente).

Demora bastante (6 meses × 50 símbolos). Para um teste mais rápido primeiro:

```bash
python -m perpscan.validate --universe 15 --months 3
```

Opções úteis:

| Opção | Efeito |
|---|---|
| `--strategy v1` | corre a hipótese antiga (reversão) — **rejeitada**, só para comparação |
| `--target tp1` | alvo no primeiro nível (saída de reversão); default é `tp2`, o extremo da tendência |
| `--exit trail` | stop dinâmico — **EXPERIMENTAL, não calibrado**: inventa lucro em martingala, não decide nada |
| `--months N` | meses de história (paginado); sem isto usa `--limit` barras |
| `--no-funding` | desliga o veto de funding (menos pedidos à API, mais rápido) |
| `--exclude ABC,XYZ` | exclui baseCoins extra do universo |
| `--no-triage` | desliga a camada de triagem (para medir quanto ela contribui) |
| `--split dev` | primeiros 70% do histórico (**default**) — é aqui que se trabalha |
| `--split holdout` | últimos 30%, **teste final único**; exige `--confirmo-holdout` |

## Estratégias

- **v2 (ativa)** — `gate_trend_pullback`: só negoceia **a favor da tendência**
  (SMA120 com declive), à entrada de um **recuo** a um nível testado, com **veto
  de funding** no lado sobrelotado. Sem sinal completo, não faz nada.
  Ver secção 5.3 do framework.
- **v1 (rejeitada)** — `gate_structure`: reversão nos extremos do range.
  Reprovada na validação (ver Apêndice B do framework). Mantida como grupo de
  controlo.

## O que falta (próximos passos da componente Python)

- Portar a camada de pressão (H1–H4) e a pontuação qualitativa (secção 7) — só
  **depois** da Fase 3 passar.
- Paper trader / walk-forward contínuo e kill-switch (secção 9).
