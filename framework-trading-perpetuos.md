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

### 5.2 Gate 1 — Estrutura (v1 — **REJEITADA**, mantida para comparação)

> **ESTADO: REJEITADA na validação de 2026-08-08.** Em walk-forward sobre dados
> reais da Bybit, a hipótese "reverter nos extremos do range" foi *pior* que
> entradas aleatórias numa janela (10 símbolos/12 dias: média −0.43 R vs −0.22,
> p=5e-5) e instável noutra (22 símbolos/42 dias: média −0.04 R, ainda
> negativa). Diagnóstico: aposta contra o momentum documentado de cripto, sem
> filtro de tendência, com sobre-negociação (~10 decisões/símbolo/dia). O
> código permanece disponível (`--strategy v1`) como grupo de comparação.
> A hipótese ativa é a **v2 (secção 5.3)**.

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

### 5.3 Gate 1 v2 — Pullback com a tendência  *(hipótese ativa)*

Fundamento (práticas documentadas de traders sistemáticos e discricionários de
cripto): (a) **momentum/continuação** é o efeito mais robusto em cripto —
negoceia-se **com** a tendência de fundo, nunca contra; (b) a entrada é no
**recuo a um nível testado**, nunca a perseguir o movimento; (c) **funding
extremo** marca o lado sobrelotado — não se entra do lado da multidão que paga;
(d) **poucas trades**: sem sinal completo, o sistema não faz nada (paciência
como regra).

Passos de `gate_trend_pullback`, na ordem em que rejeitam:

1. **ATR** — como na v1.
2. **Tendência.** `SMA(TREND_SMA=120)` `[SUP]`: exige declive
   `> ±TREND_SLOPE_ATR=0.1×ATR` `[SUP]` em `TREND_SLOPE_BARS=24` barras **e**
   preço do lado certo da média. Alta → só LONG; baixa → só SHORT; plana →
   rejeita: *"sem tendência definida … — sem trade: paciência"*.
3. **Pullback.** Recuo desde o extremo das últimas `PULLBACK_LOOKBACK=48` barras
   ≥ `PULLBACK_MIN_ATR=1.0×ATR` `[SUP]`; senão rejeita: *"perseguir o
   movimento; esperar o recuo"*.
4. **Zona de entrada.** Preço a ≤ `ENTRY_TOL_ATR=0.5×ATR` `[SUP]` de um nível
   confirmado (≥2 toques) do lado da entrada (suporte para LONG, resistência
   para SHORT); senão rejeita: *"longe do suporte/resistência mais próximo"*.
5. **Veto de funding (H1 como veto).** `z(funding) ≥ +2` bloqueia LONG;
   `≤ −2` bloqueia SHORT: *"lado sobrelotado a pagar; veto de posicionamento"*.
   Calculado **point-in-time** (só observações anteriores à barra de decisão).
6. **Risco/alvos** — mesma mecânica da secção 6 (piso de custo, banda de ATR,
   stop ancorado no nível com folga 0.15×ATR). **TP1 = nível oposto mais
   próximo** além do piso de custo; **TP2 = extremo recente**.

Saída idêntica à v1: `(setups, motivos_de_rejeicao)`, motivos obrigatórios e
específicos, `why` legível.

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

`HORIZON` `[SUP]`: 240 barras no TF de validação (v3 — ~10 dias em TF60: uma
tese de momentum precisa de espaço para a tendência se desenvolver; 48 barras
truncava-a).

### 6.5 Escolha do alvo e calibração da régua

**Alvo.** `tp1` (nível oposto mais próximo) é uma saída de *reversão*: corta o
ganho no primeiro obstáculo. Colada a uma entrada de *momentum* é incoerente —
o lucro de seguir tendências vem da cauda direita. O default passa a `tp2`
(extremo da tendência).

**Saída dinâmica (trailing): NÃO VALIDADA.** Foi implementada e rejeitada como
instrumento de medida. Numa martingala — onde nenhum lucro é possível — a
versão com stop dinâmico dá E[R] ≈ +0.11 a +0.13, quando tem de dar 0. Duas
causas encontradas e corrigidas (stop pousado acima do mercado; opção grátis ao
deixar a ordem à espera em vez de sair a mercado), mas o viés persiste: **sem
alvo superior a distribuição de R tem cauda tão pesada que a média não é
estimável** com as amostras disponíveis. Fica em `--exit trail` com aviso
explícito e não decide nada.

**Regra geral (calibração):** antes de uma regra de saída ser usada para julgar
uma estratégia, tem de provar E[R] ≈ 0 numa martingala com caminho intra-barra.
Testado em `tests/test_harness_power.py::TestExitCalibration`.

> Nota metodológica descoberta pelo caminho: séries sintéticas com **uma barra =
> um salto** são inadequadas para testar stops. O preço ultrapassa o nível em
> ~0.6% antes de ser detetado, e a convenção "o stop enche no nível" passa a
> valer ~+0.4 R de lucro fictício por trade. As séries de teste passaram a ter
> caminho intra-barra (20 micro-passos).

### 6.4 Sizing (herdado da app, para as sugestões)

- Risco por trade **0.5–1%** do capital (default 0.75%); risco/dia 2%; /semana 5%;
  drawdown máx 12%; alavancagem máx **1.8×**; R:R combinado mín **1.8** (com
  partial closes 40/35/25% em TP1/2/3). Estes limites são de **gestão**, não de
  seleção — a seleção é a secção 5.

---

## 7. Camada de triagem (análise técnica)

Só se aplica a setups que **passaram os gates**. **Só corta, nunca ressuscita** —
um setup rejeitado por um gate continua rejeitado.

**Fundamento aritmético.** Cada trade paga uma portagem fixa em R
(`custo_round_trip / distância_do_stop` ≈ 0.11 R em TF60). Com uma vantagem
bruta da mesma ordem, o lucro líquido é nulo. A alavanca não é *acertar mais* —
é **negociar menos**: ficar com a fração melhor dos setups paga a portagem
proporcionalmente menos vezes.

Filtros (`triage.py`), todos com limiares **de manual**, não procurados nos dados:

1. **ADX ≥ 25**, medido **no extremo recente, antes do recuo**. Medi-lo na barra
   de entrada seria contraditório: durante um recuo o ADX cai por construção,
   logo exigir ADX alto no recuo é exigir que o recuo não exista. O que interessa
   é a força da tendência que fez a pausa.
2. **RSI(14)** não esticado na direção do trade (≥70 corta LONG, ≤30 corta
   SHORT): entrar num recuo é comprar fraqueza temporária; com o RSI no extremo,
   o movimento já foi feito.
3. **Volume < 3× a média(20)**: um recuo com clímax de volume é distribuição ou
   pânico, não uma pausa ordenada.
4. **Long/short ratio** (desligado por defeito — histórico limitado na API):
   corta quando ≥60% das contas estão do mesmo lado do trade.

**Qualidade do universo** (`universe_quality`, triagem fundamental mínima):
exige ≥2000 barras de histórico, o que exclui listagens recentes — o universo
observado incluía tokens acabados de listar (BLESS, GWEI, TUT, MMT, BTW) a par
de BTC e ETH.

Cada corte traz motivo específico, como nos gates.

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
7. **Trades não-sobrepostas.** Depois de uma entrada, o símbolo fica ocupado até
   a trade fechar (stop, TP ou timeout). Sem isto, a mesma oscilação é contada
   dezenas de vezes e a estatística infla artificialmente. Aplica-se igualmente
   ao baseline.
8. **Sub-períodos.** A amostra é dividida em **três terços cronológicos** e a
   média de R é reportada em cada um.

### Critérios de aprovação (definidos à partida)

Os **três** têm de passar. Falha um → REPROVADO.

> **A. Distingue-se do acaso.** Welch `p < 0.05` **e** média de R superior à do
> baseline aleatório.
>
> **B. Expectância positiva.** Média de R **> 0**, líquida de custos. Bater o
> baseline com expectância negativa é perder dinheiro mais devagar — não é edge.
> *(Critério acrescentado em 2026-08-08: a v1 "passou" o A com média −0.04 R, o
> que expôs a lacuna de só comparar com o aleatório.)*
>
> **C. Consistência.** Média positiva em **≥2 dos 3 sub-períodos**. Um edge que
> só existe numa janela é ruído com sorte. *(A v1 inverteu de sinal entre duas
> janelas — significativamente pior numa, significativamente melhor noutra.)*

### Critério de abandono

> Se os critérios não passarem, dizê-lo diretamente. **Não** procurar
> parametrizações alternativas até encontrar uma que "funcione" — isso é
> sobreajuste e não se dá por ele.
>
> O caminho legítimo é **rever a hipótese** à luz do que falhou (que critério,
> em que sub-período) e testar a hipótese revista — registando a rejeição
> anterior, como está feito na secção 5.2 para a v1.

O harness (`scanner/perpscan/validate.py`) imprime as duas distribuições, os
sub-períodos, o `p`, os três critérios com ✓/✗, e o veredicto explícito.

### 8.1 Holdout — a regra que impede o auto-engano

A partir da introdução da camada de triagem (secção 7), o histórico é dividido
**cronologicamente**:

- **DEV — primeiros 70%.** É aqui que se desenvolve, compara e ajusta.
- **HOLDOUT — últimos 30%.** Fechado à chave. Serve para **um único** teste
  final.

O CLI **recusa** abrir o holdout sem `--confirmo-holdout`. Abrir, ver o
resultado e voltar a afinar transforma-o em mais um conjunto de treino: a partir
daí deixa de haver forma de saber se a estratégia funciona ou se foi moldada aos
dados. A divisão é sobre as **decisões**, não sobre os indicadores — uma decisão
no holdout pode olhar para trás para calcular médias, o que é o seu próprio
passado e não fuga de informação.

Motivo pelo qual isto foi introduzido agora: os filtros da secção 7 foram
escolhidos **depois** de ver a v1, v2 e v3 falharem. Escolher filtros à luz de
resultados já vistos é exatamente como se produz sobreajuste sem dar por ele. O
holdout é a única defesa.

### Validação do próprio harness (controlos)

Um veredicto só tem valor se a régua souber distinguir os dois casos. Ambos os
controlos correm nos testes (`tests/test_harness_power.py`):

- **Controlo positivo** — séries com momentum genuíno (o efeito que a v2 diz
  explorar): o harness **aprova** (média +0.44 R, positiva nos três terços,
  p≈1e-14). Prova que é *capaz* de detetar edge.
- **Controlo negativo** — passeio aleatório, sem edge por construção: o harness
  **reprova**. Prova que não aprova ruído.
- **Sem look-ahead** — alterar o futuro depois da barra de decisão não muda a
  decisão.

Sem o controlo positivo, um "REPROVADO" seria ambíguo (régua cega ou ausência de
edge?). Com ele, é informação.

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
| `HORIZON` | 240 barras | 6.3 | `[SUP]` |
| `target` | tp2 (extremo) | 6.5 | v3 |
| `exit_mode` | tp (calibrada) | 6.5 | v3 |
| `abandono p` | 0.05 | 8 | prompt |
| `TREND_SMA` | 120 barras | 5.3 | `[SUP]` |
| `TREND_SLOPE_BARS` | 24 barras | 5.3 | `[SUP]` |
| `TREND_SLOPE_ATR` | 0.1 × ATR | 5.3 | `[SUP]` |
| `PULLBACK_LOOKBACK` | 48 barras | 5.3 | `[SUP]` |
| `PULLBACK_MIN_ATR` | 1.0 × ATR | 5.3 | `[SUP]` |
| `ENTRY_TOL_ATR` | 0.5 × ATR | 5.3 | `[SUP]` |
| `FUNDING_Z_VETO` | ±2.0 | 5.3 | app/prompt |

### Apêndice B — Registo de hipóteses testadas

| Data | Hipótese | Amostra | Resultado |
|---|---|---|---|
| 2026-08-08 | **v1** — reversão nos extremos do range | 10 símb./~12d | REPROVADA: −0.43 R vs −0.22 do aleatório (p=5e-5, pior que o acaso) |
| 2026-08-08 | **v1** — repetida em janela maior | 22 símb./~42d | REPROVADA: −0.04 R (bate o aleatório mas expectância negativa; sinal inverteu entre janelas → instável) |
| 2026-08-08 | **v2** — pullback com a tendência + veto de funding (alvo tp1, horizonte 48) | 16 símb./5.6 meses, 2914 trades | REPROVADA (B, C): −0.070 R vs −0.281 do aleatório. Bate o acaso de forma clara e **estável** (p=3e-14; terços −0.091/−0.061/−0.055) mas não paga os custos. A seleção funciona; a expectância não. |
| 2026-08-08 | **v3** — v2 com alvo no extremo da tendência (tp2) e horizonte 240 | 15 símb./3 meses, 964 trades | REPROVADA (B, C): −0.014 R vs −0.252 do aleatório. Progressão v1→v2→v3: −0.43 → −0.070 → −0.014. Cada correção de coerência aproximou de zero, mas a expectância continua negativa. |
| — | **v3 em TF superior** — mesma estratégia, TF240 | *por correr* | *pendente: `--tf 240 --months 12`* |

**Diagnóstico transversal (custos).** O relatório passa a decompor
`bruto − custos = líquido`. Em TF60 o piso de custo obriga a stops de ≈1.4%,
logo cada trade paga ≈0.11 R só de custos. Com uma vantagem bruta de ordem
+0.10 R, os custos consomem-na toda. **Não é a seleção que falha — é a
aritmética do timeframe.** Daí o teste seguinte ser em TF superior (onde o ATR
em % é maior e o mesmo custo fixo pesa proporcionalmente menos), e não mais uma
variação de regras de entrada.
