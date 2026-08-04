# validate-signal — Harness de validação (Fase 1)

Port fiel (Deno/TS) do harness Python de **validação** de indicadores
(`harness.py` + `evaluate.py`). Mede se um conjunto de indicadores tem **edge
real, líquido de custos, out-of-sample**. Não é gerador de convicção — recusar
sinal é comportamento correto.

- `engine.ts` — núcleo puro (indicadores, regime, sinal, triple-barrier,
  estatística IS/OOS). Sem dependências Deno → testável em Node.
- `index.ts` — datafeed Bybit v5 kline (mesmos endpoints do `index.html`) +
  handler HTTP. Corre no runtime da Supabase, que alcança `api.bybit.com`.

## Regras duras preservadas
- Sinal na vela FECHADA N, execução no OPEN de N+1 (zero look-ahead/repaint).
- Custos SEMPRE deduzidos: `taker*2 + slippage*2 + funding`.
- Osciladores correlacionados = **um voto por família**.
- Regime por ADX: 20–25 = zona morta = **no-trade**.
- Só o **OOS** conta. IS a brilhar + OOS a colapsar = overfit.

## Correção do funding (era hardcoded a 1h)
`evaluate.py` pró-rateava o funding assumindo velas de 1h (`bars/8h`). Aqui é
**parametrizado pelos minutos reais** da vela via `TF_MAP[tf]` →
`hours_held = bars * bar_minutes / 60` (ver `evaluateTrade` em `engine.ts`).
Cross-check numérico: TS == Python em 1h (823 trades idênticos) e o fix em 15m
bate certo com a versão Python corrigida.

## Correr (Fase 1)
```bash
supabase functions deploy validate-signal --no-verify-jwt
# backtest BTC 1h (puxa ~5000 velas => n>200 trades):
curl "$SUPABASE_URL/functions/v1/validate-signal?symbol=BTCUSDT&tf=60&maxBars=5000"
# último sinal da vela fechada (sem forçar trade):
curl "$SUPABASE_URL/functions/v1/validate-signal?symbol=BTCUSDT&tf=60&mode=live"
```

### Parâmetros
| param     | default   | nota                                            |
|-----------|-----------|-------------------------------------------------|
| `symbol`  | `BTCUSDT` | perp linear USDT                                |
| `tf`      | `60`      | `1`,`5`,`15`,`60`,`240`,`D`… (min. por vela)    |
| `maxBars` | `5000`    | velas a puxar (paginação 1000/pedido)           |
| `oosFrac` | `0.35`    | fração out-of-sample                            |
| `mode`    | `backtest`| `backtest` \| `live`                            |

A resposta traz `report` (all/is/oos) e `summary_row`
(`par|tf|n|win%_oos|expectancy_R_oos|pf_oos|suficiente`). `suficiente=false`
quando `n_oos < 200` → amostra não chega, não confies.

**Fase 1 não integra nada no dashboard.** Integração no motor de scoring só
depois de aprovares as configs com expectancy OOS > 0 e n suficiente.
