# Framework de Trading — Perpétuos USDT (Bybit)

> **Estado do documento.** Este ficheiro é a **especificação operacional** do
> screener. Foi reconstruído a partir (a) da app existente (`index.html`, tab
> SCAN e restantes) e (b) da prompt da camada estrutural. Onde um valor não
> estava fixado em lado nenhum, está marcado **`[SUP]`** (suposição a ratificar):
> são pontos de decisão para o dono do sistema, não factos. As secções 5, 6, 8 e
> 9 são a espinha dorsal da camada de seleção estrutural e estão escritas ao
> nível de detalhe suficiente para servir de contrato ao código
> (`scanner/perpscan/` em Python, e a tab SCAN em JS espelham-nas).

Índice:

1. Objetivo e princípios
2. Universo e dados
3. Regime de mercado
4. Camada de pressão (posicionamento)
5. **Gates de seleção estrutural**
6. **Risk engine: custos, piso de custo, barreira tripla**
7. Pontuação qualitativa
8. **Validação e critério de abandono**
9. **Operação e governança**

---

## 1. Objetivo e princípios

Selecionar, num universo de perpétuos USDT da Bybit, os pares que oferecem um
**trade utilizável** — com borda estrutural, espaço para o alvo pagar os custos, e
risco definido — e apresentá-los como sugestões completas para **aprovação
humana**. Nunca execução automática, nunca aconselhamento financeiro.

Princípios não-negociáveis:

- **Os gates são binários.** Um par ou tem trade utilizável ou não tem. Nenhuma
  pontuação qualitativa (secção 7) compensa a falha de um gate.
- **Custos primeiro.** Todo o P&L é medido líquido de custos de round-trip. Win
  rate isolado não é métrica; o que conta é a expectância líquida em R.
- **Justificação legível.** Cada nível e cada rejeição trazem texto explícito
  (quantos toques, a que preço, há quantas barras; ou o motivo exato da rejeição).
  A camada é também pedagógica.
- **Zero candidatos é um resultado válido**, não um bug. Preferir qualidade a
  quantidade; baixar limiares para "devolver mais" é sobreajuste.
- **Validação antes de crença.** Um gate só é aceite depois de se distinguir de um
  baseline aleatório de forma estatisticamente significativa (secção 8).

---

## 2. Universo e dados

- **Categoria:** `linear` (perpétuos USDT), Bybit v5 público.
- **Exclusões:** símbolos com dígitos no *coin* (ex.: `1000PEPE` fica; mas
  contratos com número tipo índices/leveraged tokens são filtrados) — critério
  atual da app: `!/[0-9]/.test(coin)`. `[SUP]` a rever.
- **Fontes REST usadas:** `tickers` (preço, turnover 24h, funding, price24hPcnt),
  `kline` (OHLCV; TF de trabalho 15m, TF de regime 60m), `funding/history`,
  `open-interest`, `account-ratio` (long/short do crowd).
- **Ordenação cronológica:** klines guardadas do mais **antigo → mais recente**
  (a Bybit devolve o inverso; inverter na ingestão).

---

## 3. Regime de mercado (TF 60m)

Classificador de regime, usado como filtro (não como score direto):

- **Trending** se `ADX(14) ≥ 25`. Direção pelo lado de `SMA(20)`.
- **Squeeze** se a largura de Bollinger(20,2) estiver no percentil **< 15%** da
  sua própria história (penaliza tudo exceto breakout).
- **Ranging** caso contrário. Mean-reversion só pontua bem em ranging.

`[SUP]` limiares 25 / 15% herdados da app.

---

## 4. Camada de pressão (posicionamento)

Hipóteses de edge por posicionamento de derivados (score qualitativo, secção 7):

- **H1 — Funding squeeze.** `|z-score(funding, ~100 períodos)| ≥ 2` sem
  confirmação de preço → fade do lado sobrelotado.
- **H2 — OI divergence.** OI +5%/6h com preço a variar <0,4% = combustível
  bidirecional; OI −6%/6h = flush/exaustão → fade.
- **H3 — Cascade fade.** Vela TF15 com range >2,5×ATR(14), volume >3×média(20) e
  OI −2%/2h = proxy de cascata → mean-reversion contra a vela.
- **H4 — Filtro de regime** (secção 3).
- **+ Estrutura** (secção 5): posição no range.

Pesos atuais (secção 7): Funding 30 · OI 25 · Cascata 20 · Regime 15 · Estrutura 10.

Esta camada é **posterior** aos gates: só pontua pares que já passaram a secção 5.

---

## 5. Gates de seleção estrutural  *(espinha dorsal)*

Decide **que pares têm sequer um trade utilizável**, antes de qualquer pontuação.
Dois gates, ambos **binários**. A ordem importa: Gate 0 antes de Gate 1.

### 5.1 Gate 0 — Liquidez

Um par passa o Gate 0 se e só se:

- `turnover_24h ≥ MIN_TURNOVER` — **`MIN_TURNOVER = 30M USD`** `[SUP]`.
- `last_price` finito e `> 0`.

Motivo de rejeição obrigatório e específico, ex.:
`"liquidez insuficiente: turnover 24h 12.4M < 30M"`.

`[SUP]` Extensões previstas quando houver dados: filtro de spread médio
(bid/ask) e de profundidade do livro. Enquanto não existirem, o turnover é o
proxy único.

### 5.2 Gate 1 — Estrutura

Trabalha sobre klines TF15 (≥ ~300 barras). Passos, na ordem em que rejeitam:

1. **ATR.** `atr = ATR(14)` (Wilder). Se série curta ou `atr ≤ 0` → rejeita.
2. **Range e posição.** `range = [min(low), max(high)]` nas últimas
   `RANGE_LOOKBACK = 96` barras (≈24h em TF15). `pos = (preço − low)/(high − low)`
   em `[0,1]`.
3. **Zona morta.** Se `DEAD_LO < pos < DEAD_HI` (**`0.35 / 0.65`** `[SUP]`) →
   rejeita: *"preço no percentil X% do range — zona morta: sem borda estrutural"*.
   Sem borda estrutural, não há trade — independentemente de qualquer sinal.
4. **Direção.** `pos ≤ DEAD_LO → LONG` (fundo do range);
   `pos ≥ DEAD_HI → SHORT` (topo do range).
5. **Níveis.** Pivots fractais **confirmados** (`left = right = 3`, sem repintar),
   agrupados em clusters com tolerância `CLUSTER_TOL = 0.6 × ATR` `[SUP]`. Cada
   cluster conta toques; só valem níveis com **`≥ MIN_TOUCHES = 2`** toques. Sem
   níveis confirmados → rejeita: *"sem níveis confirmados (≥2 toques)…"*.
6. **Piso de custo e banda de ATR.** (ver secção 6). Se o ATR for baixo demais
   para caber um stop **acima do piso de custo e dentro da banda de ATR** →
   rejeita explicitamente e **sugere timeframe superior**.
7. **Stop.** Ancorado no nível estrutural do lado da entrada (suporte para LONG,
   resistência para SHORT), com folga de `0.15 × ATR`. Nunca inferior ao piso de
   custo; nunca superior ao topo da banda de ATR (senão rejeita — risco por trade
   excessivo).
8. **Alvos.** **TP1 = nível oposto mais próximo** (acima do piso de custo);
   **TP2 = extremo do range**. Nunca o contrário. Sem nível oposto com espaço →
   rejeita: *"sem nível oposto acima do piso de custo — sem espaço para TP1"*.
9. **R:R mínimo.** `R:R até TP1 ≥ MIN_RR1 = 1.0` para o setup ser utilizável (a
   selecção de R:R mais exigente é da secção 6/7).

Saída de `gate_structure`: `(setups, motivos_de_rejeicao)`. Os motivos são
**obrigatórios e específicos** — nunca `"falhou"`. Cada setup traz `dir`, `entry`,
`stop`, `stop_dist`, `tp1`, `tp2`, `rr1`, `rr2`, os níveis usados e um `why`
legível.

---

## 6. Risk engine: custos, piso de custo, barreira tripla

### 6.1 Custos

- Taker fee por lado: **0.055%**; slippage estimado por lado: **0.030%**.
- **Custo round-trip ≈ 0.17%** (`2 × (0.055% + 0.030%)`).

### 6.2 Piso de custo (regra central)

A **distância mínima ao stop** é o **máximo** entre:

- a **banda de ATR**: `[ATR_BAND_MIN × ATR, ATR_BAND_MAX × ATR]` com
  **`1.0 / 2.5`** `[SUP]`; e
- o **piso de custo**: `COST_FLOOR_MULT × custo_round_trip_em_preço`, com
  **`COST_FLOOR_MULT = 8`**.

Ou seja: `stop_dist_min = max(ATR_BAND_MIN × ATR, 8 × round_trip_preço)`.

Se `piso_de_custo > ATR_BAND_MAX × ATR`, **não existe** stop simultaneamente acima
do piso e dentro da banda → o par é rejeitado com essa razão e a sugestão de
**usar um timeframe superior** (onde o ATR em preço é maior).

### 6.3 Barreira tripla (avaliação de um trade)

Dado `entry`, `stop`, `tp`, `dir` e o futuro (highs/lows/closes após a entrada):

- **Barreira inferior/superior:** se o preço toca o stop → `R = −1 − custo_R`; se
  toca o TP → `R = (|tp − entry| / |entry − stop|) − custo_R`.
- **Barreira vertical (timeout):** ao fim de `HORIZON` barras sem tocar nenhuma →
  fecha a mercado; `R = P&L_em_risco − custo_R`.
- `custo_R = custo_round_trip_fração × entry / |entry − stop|` (custos em unidades
  de R).

`HORIZON` `[SUP]`: 48 barras no TF de validação.

### 6.4 Sizing (herdado da app, para as sugestões)

- Risco por trade **0.5–1%** do capital (default 0.75%); risco/dia 2%; /semana 5%;
  drawdown máx 12%; alavancagem máx **1.8×**; R:R combinado mín **1.8** (com
  partial closes 40/35/25% em TP1/2/3). Estes limites são de **gestão**, não de
  seleção — a seleção é a secção 5.

---

## 7. Pontuação qualitativa (resumo)

Só se aplica a pares que **passaram os gates**. Score composto determinístico a
partir de H1–H4 + regime + estrutura (pesos na secção 4), traduzido em confiança
0–10 e ajustado por R:R, nº de confluências e alinhamento do posicionamento.
Mesmo input → mesmo score. O score **nunca** ressuscita um par rejeitado pelos
gates.

---

## 8. Validação e critério de abandono  *(espinha dorsal)*

A camada estrutural só é aceite se provar que **não é cosmética**. Metodologia:

1. **Universo:** ≥ **50 símbolos líquidos**.
2. **História:** ≥ **6 meses** de klines. (No harness Python: TF configurável;
   default de trabalho TF60 com ~180 dias.)
3. **Walk-forward, sem look-ahead.** Em cada barra `i`, decide-se **só** com dados
   até `i`; avalia-se com `i+1 …`. Repintar pivots é proibido (por isso os pivots
   exigem `right` barras confirmadas).
4. **Avaliação:** cada setup aprovado é avaliado por **barreira tripla líquida de
   custos** (secção 6.3), guardando o R.
5. **Baseline de controlo:** entradas **aleatórias** nos **mesmos símbolos**, nas
   **mesmas horas**, com a **mesma distância de stop** (mediana dos aprovados) e o
   **mesmo alvo em R**. Direção aleatória.
6. **Comparação de distribuições de R:** média, mediana, desvio, % de resultados
   positivos, e **teste de significância** (Welch dos dois grupos).

### Critério de abandono (definido à partida)

> Se os setups aprovados **não** se distinguirem do baseline aleatório de forma
> **estatisticamente significativa** (`p < 0.05` **e** média de R superior), o
> gate é **cosmético** e **não se avança para a Fase 4**.
>
> Neste caso, dizê-lo diretamente. **Não** procurar parametrizações alternativas
> até encontrar uma que "funcione" — isso é sobreajuste e não se dá por ele.

O harness (`scanner/perpscan/validate.py`) imprime as duas distribuições, o `p`, e
o veredicto explícito segundo esta regra.

---

## 9. Operação e governança  *(espinha dorsal)*

Como a camada encaixa no sistema e o que a rodeia:

- **Ordem do funil:** Universo → **Gate 0** → **Gate 1 (estrutura)** → pontuação
  qualitativa (secção 7) → risk engine/sizing → sugestão + confiança. Os gates são
  o filtro de entrada; tudo o resto é a jusante.
- **Human-in-the-loop obrigatório.** O sistema **sugere**; a execução é sempre
  aprovada por uma pessoa. Sem ordens automáticas.
- **Paper trading antes de go-live.** Loop de paper com fees/slippage/funding
  reais, kill-switch diário a −3%; **go-live só após ≥ 60 dias de paper com
  expectância positiva**.
- **Camadas de backend (fora do browser):** sentimento social (X/LunarCrush/
  Santiment), on-chain (Glassnode/Nansen), LLM analyst (veto qualitativo cético) e
  o paper trader vivem num serviço Python com chaves — nunca no cliente.
- **Reprodutibilidade.** Mesma configuração + mesmos dados → mesmo resultado. A
  validação usa PRNG com seed fixa para o baseline.
- **Governança de limiares.** Qualquer alteração a um valor `[SUP]` é uma decisão
  registada aqui, não um ajuste silencioso no código. Alterar limiares para o
  scanner devolver mais candidatos é explicitamente proibido.

---

### Apêndice A — Constantes de referência

| Constante | Valor | Secção | Estado |
|---|---|---|---|
| `MIN_TURNOVER` | 30M USD | 5.1 | `[SUP]` |
| `RANGE_LOOKBACK` | 96 barras | 5.2 | `[SUP]` |
| `DEAD_LO / DEAD_HI` | 0.35 / 0.65 | 5.2 | `[SUP]` |
| `CLUSTER_TOL` | 0.6 × ATR | 5.2 | `[SUP]` |
| `MIN_TOUCHES` | 2 | 5.2 | `[SUP]` |
| `ATR_BAND_MIN/MAX` | 1.0 / 2.5 × ATR | 6.2 | `[SUP]` |
| `COST_FLOOR_MULT` | 8 × round-trip | 6.2 | prompt |
| `custo round-trip` | ≈ 0.17% | 6.1 | app |
| `MIN_RR1` | 1.0 | 5.2 | `[SUP]` |
| `HORIZON` | 48 barras | 6.3 | `[SUP]` |
| `abandono p` | 0.05 | 8 | prompt |
