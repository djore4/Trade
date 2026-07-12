# Consola de Investimentos

Aplicação **local, single-user** para controlar e simular a minha carteira de
investimentos (spot cripto, uma ação alavancada, um PPR). Corre na minha
máquina, os dados são meus e ficam locais (SQLite).

> **Isto não é aconselhamento financeiro nem fiscal.** A app apresenta cálculos e
> sinais da minha regra pré-definida e *estima* números fiscais — não substitui
> contabilista. **Não executa ordens** e é **read-only**.

Interface em **português (PT-PT)**. Base monetária **EUR** (ativos em USD
convertidos por uma taxa EUR/USD com override manual).

---

## O que faz

1. **Tracker** das posições (spot cripto, MSTR, PPR) com valor de mercado, P&L
   por custo médio e alocação em EUR, por titular e agregado.
2. **Motor de estratégia**: escada de quedas (DCA base + reserva de volatilidade),
   orçamento de reserva por ativo com travão, kill-switch e sinal **mNAV** da MSTR.
3. **Simuladores**: saída de posições alavancadas (linear/inverso, com liquidação
   e funding) e comparação de cenários de acumulação (DCA linear vs DCA + reserva).
4. **Fiscalidade PT**: registo lote a lote, regra dos 365 dias, FIFO e estimativa
   de imposto na venda.

## Módulos

| Módulo | Descrição |
|---|---|
| **Dashboard** | Valor total EUR por bucket, alocação vs alvo, P&L por titular. |
| **Tracker** | Spot + MSTR: preço, custo médio, queda vs topo, escada e sugestão de reforço; mNAV na MSTR. |
| **Lotes & Fiscal** | Transações (CRUD), 365 dias, próximo desbloqueio, simulador de venda FIFO com imposto. |
| **Inversos** | Posições alavancadas: liquidação (a vermelho), funding, P&L linear **e** inverso, simulação por preço de saída. |
| **Cenários** | DCA linear vs DCA + reserva sobre a mesma trajetória. Comparação, **não** previsão. |
| **PPR** | Save & Grow (titularidade da Patrícia). Valores manuais, botão de cotação (degrada para manual). |
| **Definições** | EUR/USD, cadência DCA, janela do topo, escada, alvos, inputs mNAV, estado das integrações. |

---

## Arranque (um comando)

```bash
make install        # instala dependências (FastAPI, uvicorn, httpx)
make dev            # arranca em http://127.0.0.1:8000
```

Alternativa sem make:

```bash
pip install -r requirements.txt
python3 run.py
```

A base de dados é criada automaticamente no primeiro arranque, com um *scaffold*
das contas e do catálogo de ativos (símbolos + quadrante). **Não são inventados**
quantidades, preços nem cotações — esses são sempre introduzidos por ti.

Funciona **100% em modo manual, sem qualquer chave de API**. As integrações são
opcionais e cada uma degrada com elegância para entrada manual.

---

## Chaves de API (opcional, só de leitura)

As chaves vivem **apenas** no ficheiro `.env` (que está no `.gitignore`). Nunca
são escritas no código, na base de dados, na UI nem em logs.

```bash
cp .env.example .env
# edita .env e coloca chaves Bybit SÓ DE LEITURA (read-only)
```

- A app **nunca** coloca ordens, nunca move fundos, nunca usa endpoints de trade.
- Cria a chave Bybit **apenas com permissões de leitura**. Em *Definições →
  Integrações* a app verifica e avisa se detetar permissões de escrita.
- Sem chaves, as posições/funding entram manualmente no módulo **Inversos**.

## Fontes de dados

| Dado | Fonte | Sem fonte? |
|---|---|---|
| Preços cripto + máximo 60–90d | Bybit **pública** (sem chave) | entrada manual do preço/topo |
| Posições e funding Bybit | Bybit **privada** (chave read-only) | entrada manual |
| EUR/USD | Frankfurter/BCE (pública) | override manual em Definições |
| Preço MSTR e BTC | Yahoo Finance (pública) | entrada manual |
| Posições MSTR | **manual** (Trading 212 sem API de retalho fiável) | — |
| BTC-treasury / ações (mNAV) | **manual** com data | — |
| Cotação PPR | sem fonte pública fiável → **manual** | — |

O refresh de preços é **manual** (botão no Tracker). Nada depende de estar
sempre ligado.

---

## Modelos e fórmulas (honestidade dos números)

- **Liquidação** (perps): aproximada, margem isolada, exclui taxas e margem de
  manutenção real — na prática liquida antes. Marcada como aproximação.
- **P&L linear vs inverso**: fórmulas distintas. Linear é USDT-margined (payoff
  linear); inverso é coin-margined (payoff não-linear na margem/ROI). O funding é
  subtraído ao P&L bruto.
- **Custo médio**: mostra "como estás", **não** serve para decidir vendas — para
  isso usa a vista de **Lotes** (365 dias + FIFO).
- **365 dias**: mais-valias de cripto spot detida ≥ 365 dias são isentas; abaixo,
  28%. Lote a lote, cada compra com o seu relógio.
- **Derivados**: não contam para os 365 dias; tributados à parte; trading
  frequente pode cair em categoria B. P&L separado do spot.
- **PPR**: fiscalidade própria; **titularidade distinta** (Patrícia) — nunca
  somada à minha.
- **Cenários**: comparação relativa de estratégias sobre a mesma trajetória.
  **Nunca** uma previsão de retorno.
- **DAC8**: a Bybit reporta à AT. Nota informativa na secção fiscal.

---

## Arquitetura

- **Backend**: Python + FastAPI, SQLite (stdlib `sqlite3`, sem ORM). Serviços de
  dados separados (`backend/services/`), cada um com cache e fallback manual.
  Motor de cálculo puro e testável em `backend/engine/`.
- **Frontend**: web local servido pelo backend — HTML + JS *vanilla* (sem build
  step). Escolhido por ser leve, local-first e adequado à estética de consola
  (fundo escuro, monospace tabular, verde/vermelho/âmbar, liquidação sempre a
  vermelho). Sem floreados.
- **Persistência**: `data/console.db` (no `.gitignore`).

```
backend/
  main.py            FastAPI + serve o frontend
  db.py / schema.sql SQLite + scaffold idempotente
  config.py          .env e definições por omissão (segredos só em env)
  engine/            ladder, mnav, perp, tax, scenarios  (matemática pura)
  services/          bybit, fx, stocks, ppr  (degradação elegante)
  routers/           dashboard, tracker, lots, perps, scenarios, ppr, settings, accounts
frontend/            index.html, app.js, styles.css
tests/               test_engine.py
```

## Testes

```bash
make test   # cobre escada, 365d/FIFO, perps linear+inverso, mNAV e cenários
```

## Ordem de construção

Fase 1 (núcleo manual) → Fase 2 (motor) → Fase 3 (dados live) → Fase 4 (fiscal)
→ Fase 5 (cenários). Todas entregues e testáveis; o núcleo funciona sem uma
única API.
