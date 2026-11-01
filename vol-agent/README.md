# vol-agent — fase 1: backtest

Grid long-only em spot (BTCUSDT, ETHUSDT), ligado só quando o mercado está em range
(ADX baixo + largura das Bollinger abaixo da mediana de 30 dias). Capital alvo: $100.

## Correr

```bash
pip install polars numpy pyarrow requests
python fetch_klines.py --symbols BTCUSDT ETHUSDT --interval 60 --days 1095
python backtest.py              # otimiza no in-sample (tudo menos os últimos 180 dias)
python backtest.py --holdout    # UMA vez: avalia a config congelada no holdout
```

O fetch usa o endpoint público da Bybit (sem chaves). Corre no teu PC ou no VPS.

## Regras do jogo (definidas antes de ver dados)

- Parâmetros escolhidos só no in-sample. Uma config para BTC e ETH: maximiza o pior Calmar dos dois.
- Kill criteria no holdout (todos obrigatórios): lucro líquido > 0, drawdown < 25%,
  profit factor ≥ 1,2, ≥ 30 round trips, e bater o mesmo grid sem filtro de regime.
- Se falhar: a estratégia morre. Não se mexe nos parâmetros e corre outra vez,
  porque isso é ajustar ao holdout e o teste deixa de valer.

## Simulação (deliberadamente conservadora)

- Decisão na barra t usa só informação até t−1.
- Ordens limite preenchem ao melhor de (preço da ordem, abertura) em gap; stop como stop-market com slippage.
- Um nível comprado numa barra só pode vender na barra seguinte. Isto subestima o resultado
  quando o espaçamento é pequeno face à amplitude da barra, e é por isso que o grid vai de 1,5 a 3 ATR.
- Fees de 0,1% por lado (spot, tier base) + 0,05% de slippage nas saídas a mercado.

## Próximas fases (só se o holdout passar)

2. Executor determinístico na testnet: mesmas regras, ordens reais, circuit breaker.
3. Mainnet com $100 numa subconta sem permissão de levantamento, key só Trade, IP whitelist.
4. Benchmark contínuo contra o grid bot nativo da Bybit com o mesmo capital.
