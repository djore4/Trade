# Guia da ferramenta `validate-signal` — como funciona e como a geres

> Guia de estudo e operação do harness de **validação** de sinais do CryptoScan.
> Lê isto do princípio ao fim antes de mexeres em parâmetros. A filosofia não é
> decoração — é o que impede a ferramenta de te mentir.

---

## 1. O que é (e o que NÃO é)

`validate-signal` é um **detetor de treta**, não um gerador de convicção.

O seu único trabalho é responder a uma pergunta desconfortável:

> *"Este conjunto de indicadores tem edge real, LÍQUIDO DE CUSTOS, quando
> testado em dados que ele nunca viu?"*

E a resposta certa é, quase sempre, **"não"**. Isso é uma funcionalidade, não um
bug. Se um dia "melhorares" a ferramenta para disparar mais sinais ou acender
mais verde, partiste-a — passou a dizer-te o que queres ouvir em vez da verdade.

**O que NÃO é:**
- ❌ Não é um robô de trading. Não envia ordens.
- ❌ Não decide direção com IA. Não há Claude API na decisão. É determinístico:
  mesmo input → mesmo output, sempre.
- ❌ Não está ligado ao dashboard. É uma ferramenta de laboratório, à parte.
- ❌ Não é conselho financeiro.

---

## 2. As 5 regras duras (e porque existem)

Estas regras são a razão pela qual podes confiar nos números. Cada uma fecha uma
forma comum de um backtest se enganar a si próprio.

| # | Regra | O que evita |
|---|---|---|
| 1 | **Sinal na vela FECHADA N, execução no OPEN de N+1** | *Look-ahead / repaint.* Nunca usas informação que só existiria no futuro. O sinal decide-se com a vela já fechada; a entrada é no preço a que realmente entrarias — a abertura da vela seguinte. |
| 2 | **Custos SEMPRE deduzidos** | *A ilusão do lucro bruto.* `taker × 2` (entras e sais) + `slippage × 2` + `funding` pró-rateado. Um sistema que "ganha" em bruto costuma perder depois de custos. |
| 3 | **Osciladores correlacionados = UM voto por família** | *Contar a mesma coisa 5 vezes.* RSI, Stoch, StochRSI, CCI, Williams %R e UO dizem quase todos o mesmo. Se cada um contasse, terias falsa confiança. Contam como **um** voto de mean-reversion. |
| 4 | **Regime por ADX manda: 20–25 = no-trade** | *Trocar de personalidade a meio.* Em tendência segues; em range fazes fade. Na zona morta (ADX 20–25) não há sinal claro → **não negoceias**. Não alargar esta zona "para apanhar mais". |
| 5 | **Só o OUT-OF-SAMPLE conta** | *Overfitting.* Os dados dividem-se: uma parte para "treino" (in-sample, IS) e outra que o sistema nunca viu (out-of-sample, OOS). IS a brilhar + OOS a colapsar = decoraste ruído. Só o OOS conta como veredito. |

---

## 3. Arquitetura — porque está partido em dois ficheiros

```
supabase/functions/validate-signal/
├── engine.ts   ← NÚCLEO PURO (matemática). Sem dependências Deno.
├── index.ts    ← I/O: vai buscar dados à Bybit + serve HTTP.
├── README.md   ← runbook curto (comandos)
└── GUIA.md     ← este documento
```

- **`engine.ts`** tem toda a matemática: indicadores, regime, geração de sinal,
  avaliação triple-barrier, estatística. Não sabe o que é a internet nem o Deno.
  Isto é de propósito: **pode ser testado isoladamente**. Foi assim que se provou
  que o port TypeScript dá exatamente os mesmos números que o harness Python
  original (823 trades idênticos ao bit).
- **`index.ts`** só trata de ir buscar velas à Bybit e devolver o relatório em
  JSON. É a única parte que "fala com o mundo".

Porquê edge function na Supabase e não no browser? Porque a validação puxa
milhares de velas e faz contas pesadas — não é trabalho para o dashboard. E
porque a Supabase alcança a `api.bybit.com` a partir do servidor, com os mesmos
endpoints que o `index.html` já usa. **O `index.html` não foi tocado.**

---

## 4. Como o motor decide um sinal (o coração da coisa)

Para cada vela fechada, o motor faz isto por ordem:

### Passo 1 — Qual é o regime? (ADX)
```
ADX ≥ 25          → "trend"  (tendência)
ADX ≤ 20          → "range"  (lateral)
20 < ADX < 25     → "chop"   (zona morta) → SEM SINAL
ADX indefinido    → "na"                  → SEM SINAL
```

### Passo 2a — Se TENDÊNCIA: segue a direção estrutural
Conta 4 "votos" de estrutura (não osciladores):
- Preço acima/abaixo da EMA50
- EMA50 acima/abaixo da EMA200
- MACD acima/abaixo da sua linha de sinal
- +DI acima/abaixo de −DI

Se ≥ 2 votos para cima → **long**; ≤ −2 → **short**; senão → sem sinal.
Os osciladores aqui **não invertem** a direção — só validam o *timing*
(não entrar já esticado no topo/fundo).

### Passo 2b — Se RANGE: fade dos extremos (mean-reversion)
A **família** de osciladores (RSI, Stoch, StochRSI, CCI, UO, Williams %R) vota
uma só vez:
- Maioria em sobrecompra → **short** (fade para baixo)
- Maioria em sobrevenda → **long** (fade para cima)
- Sem maioria clara → sem sinal

### Passo 3 — Confiança mínima
Calcula-se uma confiança 0..1. Se abaixo de `min_conf` (default 0.34) → sem sinal.

### Passo 4 — Stop, alvo e sizing
```
stop   = entry ∓ 1.5 × ATR
target = entry ± 1.5 × 1.5 × ATR   (ou seja, alvo a 1.5R)
size   = 1% do equity ÷ distância ao stop
```

Se em qualquer passo faltar dado ou não houver convicção, o resultado é **`null`
= sem sinal**. Recusar é o comportamento correto.

---

## 5. Como um trade é avaliado (triple-barrier + custos)

Depois de um sinal na vela N, entra-se no **open de N+1** e percorre-se o futuro
até no máximo `max_hold_bars` (24) velas. Três "barreiras":

1. **Toca no target primeiro** → `win`
2. **Toca no stop primeiro** → `loss`
3. **Não toca em nenhum até ao timeout** → `scratch` (fecha ao close)

Depois deduzem-se os custos:
```
gross_pct = direção × (saída − entrada) / entrada
funding   = funding_per_8h × (bars × minutos_da_vela / 60) / 8      ← ver §6
net_pct   = gross_pct − 2×(taker + slippage) − funding
realized_R = net_pct × entrada / distância_ao_stop
```

`realized_R` é o resultado em múltiplos de risco (R). +1R = ganhaste o que
arriscaste; −1R = perdeste o que arriscaste. **É a métrica que interessa.**

---

## 6. A correção do funding (importante entender)

O harness Python original tinha um bug: pró-rateava o funding assumindo sempre
velas de 1 hora (`funding = funding_per_8h × bars/8`). Como `bars` é o número de
**velas**, isto só está certo em 1h. Em 15m sobrestimava o funding 4×; em 4h
subestimava 4×.

**A correção** (já aplicada aqui) parametriza pelos **minutos reais** da vela:
```
horas_no_trade = bars × minutos_da_vela / 60
funding        = funding_per_8h × horas_no_trade / 8
```
O `minutos_da_vela` vem da tabela `TF_MAP` conforme o timeframe da corrida. Foi
verificado numericamente contra a versão Python corrigida.

⚠️ **Atenção:** o `funding_per_8h` está num valor médio fixo (`0.0001`). Para um
estudo sério, o próximo upgrade é puxar o funding **real histórico** da Bybit
(a app já lê o `fundingRate` no dashboard). Ver §11.

---

## 7. Como correr

### Deploy (uma vez, ou quando mudas o código)
```bash
supabase functions deploy validate-signal --no-verify-jwt
```

### Backtest (o uso normal)
```bash
# BTC 1h, ~208 dias (5000 velas):
curl "$SUPABASE_URL/functions/v1/validate-signal?symbol=BTCUSDT&tf=60&maxBars=5000"

# BTC 1h, ~2.3 anos (20000 velas, vários regimes):
curl "$SUPABASE_URL/functions/v1/validate-signal?symbol=BTCUSDT&tf=60&maxBars=20000"

# BTC 15m:
curl "$SUPABASE_URL/functions/v1/validate-signal?symbol=BTCUSDT&tf=15&maxBars=20000"
```

### Sinal ao vivo (última vela fechada, sem forçar trade)
```bash
curl "$SUPABASE_URL/functions/v1/validate-signal?symbol=BTCUSDT&tf=60&mode=live"
```
Devolve o sinal da última vela **fechada** (ignora a vela em formação). Se
devolver `signal: null`, é porque o regime é chop/na ou a confiança é baixa —
**não forçar trade.**

### Parâmetros
| param | default | o que faz |
|---|---|---|
| `symbol` | `BTCUSDT` | perp linear USDT da Bybit |
| `tf` | `60` | timeframe: `1`,`5`,`15`,`60`,`240`,`D`… (minutos) |
| `maxBars` | `5000` | quantas velas puxar (pagina 1000 de cada vez, máx. 20000) |
| `oosFrac` | `0.35` | fração dos dados reservada para out-of-sample |
| `mode` | `backtest` | `backtest` ou `live` |

---

## 8. Como invocar quando o teu ambiente não alcança a função

A função vive na Supabase e alcança a Bybit. **Tu**, a partir do teu
computador/servidor, invocas com um simples `curl` (mostrado acima). Só um
ambiente com egress bloqueado (como o sandbox do Claude Code neste projeto) é que
não chega lá diretamente.

Se alguma vez precisares de a disparar **de dentro da própria Supabase** (por
exemplo, num ambiente sem rede externa), pode fazer-se via a extensão `http` do
Postgres:
```sql
create extension if not exists http with schema extensions;
select extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '150000');
select (extensions.http_get(
  'https://<REF>.supabase.co/functions/v1/validate-signal?symbol=BTCUSDT&tf=60&maxBars=20000'
)).content::jsonb;
drop extension if exists http;   -- limpa depois; a extensão abre SSRF a partir da DB
```
> **Segurança:** a extensão `http` deixa a base de dados fazer pedidos HTTP
> arbitrários (risco de SSRF). Só a ativa quando precisas e **remove-a a seguir**.
> No uso normal, prefere o `curl` externo — não precisas desta extensão.

---

## 9. Como LER o resultado (regras de decisão)

A resposta traz `report` com três blocos (`is`, `oos`, `all`) e um `summary_row`.
Só precisas de olhar para o **OOS**.

| Métrica | O que é | Como ler |
|---|---|---|
| `n` | nº de trades | **< 200 = amostra não chega**, não confies. O campo `suficiente` avisa. |
| `win_rate` | % de wins | sozinho não diz nada (podes ganhar pouco muitas vezes e perder muito poucas) |
| `expectancy_R` | **R médio por trade, líquido** | **A MÉTRICA-REI.** > 0 = há edge. ≤ 0 = sem edge. |
| `profit_factor` | ganhos ÷ perdas | > 1 = ganha; < 1 = perde. > 1.3 começa a ser interessante. |
| `max_dd_pct` / `total_return_pct` | drawdown / retorno | ⚠️ **ver aviso abaixo** |

### Regra de decisão simples
```
expectancy_R OOS > 0  E  n_oos ≥ 200  E  OOS não muito pior que IS
   → candidato a edge. Estudar mais (outros pares, mais história, robustez).
Caso contrário
   → SEM edge. Não integrar. Mudar de hipótese.
```

### ⚠️ Aviso sobre drawdown e retorno total
Os campos `max_dd_pct` e `total_return_pct` **compõem o resultado trade-a-trade
em sequência**, como se só tivesses uma posição de cada vez. Mas o backtest gera
muitos trades **sobrepostos** (ex.: 2 300 trades em 5 000 velas). Não poderias
tê-los todos abertos a 1% de risco cada. Por isso, valores como "−98% de
drawdown" são **artefactos do modelo**, não realidade.

**Métricas fiáveis: `expectancy_R`, `win_rate`, `profit_factor`** (são por-trade).
Ignora o drawdown/retorno total como número absoluto — usa-o só como sinal
qualitativo grosseiro.

---

## 10. Resultados até agora — BTC/USDT perp

| par | tf | janela | n (OOS) | win% OOS | expectancy_R OOS | PF OOS |
|---|---|---|---|---|---|---|
| BTCUSDT | 1h | ~208 dias | 852 | 32.0% | **−0.25 R** | 0.76 |
| BTCUSDT | 1h | ~2.3 anos | 3 176 | 36.3% | **−0.147 R** | 0.80 |
| BTCUSDT | 15m | ~208 dias | 3 233 | 35.9% | **−0.396 R** | 0.59 |

**Leitura:** nenhuma config tem edge. OOS negativo, estável em vários regimes,
com amostra grande em todas. O 15m é o pior — timeframe mais curto = fees +
funding proporcionalmente mais pesados por barra = mais atrito sobre um edge que
já não existia.

Isto **não** é a ferramenta a falhar. É a ferramenta a funcionar: recusa-se a
validar um conjunto de indicadores clássicos genéricos que, líquidos de custos,
não batem o mercado. Exatamente para isto serve.

---

## 11. Como GERIR a ferramenta (operação)

### Mudar parâmetros da estratégia
Todos vivem em `defaultConfig()` no `engine.ts` — muda lá, não espalhado pelo
código:
```ts
adx_trend: 25.0      // limiar de tendência
adx_range: 20.0      // limiar de range (entre os dois = no-trade)
stop_atr_mult: 1.5   // stop = 1.5 × ATR
reward_R: 1.5        // alvo a 1.5R
max_hold_bars: 24    // timeout em velas
min_conf: 0.34       // confiança mínima para disparar
costs: { taker_fee: 0.00055, slippage: 0.0002, funding_per_8h: 0.0001 }
```
Depois de mudar: **`supabase functions deploy validate-signal`** para publicar.

### Custos realistas
- `taker_fee 0.00055` = 0.055% (taker Bybit). Se usas maker, é menor — mas então
  não podes assumir execução garantida.
- `slippage 0.0002` = estimativa conservadora. Em pares menos líquidos, sobe.
- `funding_per_8h 0.0001` = média fixa. **Melhoria importante:** puxar funding
  real histórico da Bybit por par (a app já lê `fundingRate`).

### Adicionar pares / timeframes
Já é suportado sem tocar no código — passa `symbol=` e `tf=` no URL. Para pares
pouco líquidos, sobe o `slippage` antes de acreditar nos números.

### `verify_jwt` (segurança do endpoint)
A função foi deployed com `verify_jwt=false` porque só lê **kline público** da
Bybit — não há segredos nem dados de conta. É seguro. Se preferires fechá-la:
```bash
supabase functions deploy validate-signal   # (sem --no-verify-jwt)
```
…e passas a precisar do header `Authorization: Bearer <anon_key>` no `curl`.

### Remover a ferramenta
```bash
supabase functions delete validate-signal
```
Não deixa lixo: não criou tabelas nem alterou o `index.html`.

---

## 12. Fase 2 — o que vem a seguir (e porque está bloqueado)

O plano original tinha uma Fase 2 (integração). Está **bloqueada de propósito**
até haver uma config com `expectancy_R OOS > 0` e amostra suficiente. Com BTC
osciladores-clássicos, nada passou → nada a integrar. Quando (e se) algo passar:

- **(f)** Integrar `generateSignal()` no motor de scoring determinístico do
  CryptoScan como **mais um voto ponderado** — não a substituir o que já existe,
  e nunca a IA a decidir direção.
- **(g)** Modo `--live` diário: gerar o sinal da última vela fechada e registar
  num journal (reutilizando a tabela que o CryptoScan já use, não duplicar).
- **(h)** Comparador: no fim de cada semana/mês, comparar a expectancy do journal
  **real** com a do backtest. Divergência grande = o backtest está a mentir
  (custos/slippage subestimados).

### A pista mais promissora
Estes osciladores clássicos são genéricos. O **edge declarado da tua app é
outro**: *posicionamento* — funding z-score, open interest, cascatas de
liquidação, long/short ratio. É outra família de sinal e é onde faz sentido
gastar o próximo esforço de validação. O `engine.ts` está estruturado para se
lhe acrescentar essa hipótese e a passar pelo mesmo crivo honesto (regime +
triple-barrier + custos + OOS).

---

## 13. Limitações e riscos (lê antes de confiar)

- **Nenhuma config atual tem edge.** Integrá-la no scoring só adicionaria ruído
  negativo. Não o faças.
- **Funding é uma média fixa**, não o histórico real. Subestima ou sobrestima
  conforme o período.
- **Drawdown/retorno total são artefactos** (ver §9). Usa só as métricas
  por-trade.
- **Janela de dados limitada** pela paginação (máx. 20 000 velas por corrida).
  Em 1h dá ~2.3 anos; em 15m ~208 dias.
- **Bybit pode mudar** endpoints/limites. Se o kline parar de vir, é aqui que
  olhas primeiro (`fetchBybit` em `index.ts`).
- **`verify_jwt=false`**: seguro para dados públicos, mas o endpoint é aberto.
  Fecha-o se te incomodar.

---

## 14. Glossário rápido

| Termo | Significado |
|---|---|
| **IS / OOS** | In-sample (treino) / Out-of-sample (o que interessa) |
| **Expectancy R** | Resultado médio por trade em múltiplos de risco, líquido de custos |
| **R** | Uma unidade de risco (a distância entrada→stop) |
| **Profit Factor** | Soma dos ganhos ÷ soma das perdas |
| **Triple-barrier** | Método de saída: target, stop, ou timeout |
| **ADX** | Índice de força de tendência (regime) |
| **Funding** | Taxa paga entre longs e shorts nos perpétuos |
| **Look-ahead / repaint** | Usar (por erro) informação do futuro num backtest |
| **Overfit** | Decorar o ruído do passado; brilha no IS, colapsa no OOS |
| **Chop** | Zona morta de ADX (20–25) onde não se negoceia |

---

*Ferramenta de validação e apoio à decisão — nunca execução automática nem
aconselhamento financeiro. O comportamento correto inclui recusar-se a dar sinal.*
