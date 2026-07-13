# Consola de Investimentos

Aplicação **web estática, single-user**, para controlar e simular a minha
carteira de investimentos (spot cripto, uma ação alavancada, um PPR). Corre
**inteiramente no browser** — abre por URL (GitHub Pages) ou o `index.html`
local. Os dados são meus e ficam **no meu browser** (localStorage), com
export/import para backup.

> **Isto não é aconselhamento financeiro nem fiscal.** A app apresenta cálculos e
> sinais da minha regra pré-definida e *estima* números fiscais — não substitui
> contabilista. **Não executa ordens.**

Interface em **português (PT-PT)**. Base monetária **EUR** (ativos em USD
convertidos por uma taxa EUR/USD com override manual).

---

## Usar

- **Online:** abre o site (GitHub Pages do repositório).
- **Local:** abre `index.html` no browser, ou serve a pasta:
  ```bash
  python3 -m http.server 8000    # depois abre http://127.0.0.1:8000
  ```

Não há build step, nem servidor, nem instalação. Funciona **100% em modo
manual** — as APIs de dados são opcionais e cada uma degrada com elegância para
entrada manual.

## Os meus dados

Vivem no **localStorage deste browser**. Em *Definições → Dados & backup*:

- **Exportar backup (JSON)** — guarda uma cópia (faz isto com regularidade;
  limpar o browser apaga os dados).
- **Importar backup** — repõe de um ficheiro.
- **Repor scaffold** — volta ao estado inicial (contas + catálogo de ativos).

Nada é enviado para lado nenhum além das APIs públicas de dados (só leitura).

---

## Módulos

| Módulo | Descrição |
|---|---|
| **Dashboard** | Valor total EUR por bucket, alocação vs alvo, P&L por titular. |
| **Tracker** | Spot + MSTR: preço, custo médio, queda vs topo, escada e sugestão de reforço; mNAV na MSTR. |
| **Lotes & Fiscal** | Transações (CRUD), 365 dias, próximo desbloqueio, simulador de venda FIFO com imposto. |
| **Inversos** | Posições alavancadas: liquidação (a vermelho), funding, P&L linear **e** inverso, simulação por preço de saída. |
| **Cenários** | DCA linear vs DCA + reserva sobre a mesma trajetória. Comparação, **não** previsão. |
| **PPR** | Save & Grow (titularidade da Patrícia). Valores manuais. |
| **Definições** | EUR/USD, cadência DCA, janela do topo, escada, alvos, inputs mNAV, backup. |

## Fontes de dados (públicas, do lado do cliente)

| Dado | Fonte | Sem fonte? |
|---|---|---|
| Preços cripto + máximo 60–90d | Bybit pública | entrada manual do preço/topo |
| Preço BTC (para o mNAV) | Bybit pública | entrada manual |
| EUR/USD | Frankfurter/BCE | override manual em Definições |
| Preço MSTR | Yahoo Finance (pode ser bloqueado por CORS) | entrada manual |
| Posições MSTR / BTC-treasury / ações | **manual** com data | — |
| Cotação PPR | sem fonte pública fiável → **manual** | — |

Botão **"Atualizar preços"** no Tracker (manual). Se uma fonte falhar (rede ou
CORS), o módulo continua a funcionar em modo manual.

### Portefólio privado da Bybit (opcional, via proxy read-only)

Os **preços** são públicos e funcionam sempre. Ler o teu **portefólio** (saldos e
posições abertas, lineares e inversas) exige a **API privada** — chave + segredo +
assinatura. Num site estático **uma chave secreta nunca pode viver no browser** e
os endpoints privados da Bybit **não permitem CORS** de browser.

Solução: um **proxy pessoal read-only** (Cloudflare Worker) que guarda a chave
**só de leitura** como *secret* do servidor, assina os pedidos e devolve o JSON ao
site. Configuras uma vez e passas a ter:

- **Inversos → "Sincronizar da Bybit"**: posições abertas ao vivo (entrada,
  liquidação e P&L não realizado autoritativos da Bybit), lineares e inversas.
- **Tracker → "Saldos ao vivo (Bybit)"**: quantidades reais, com **reconciliação**
  face às tuas quantidades manuais (os lotes/custo médio para fiscalidade
  continuam a vir das transações manuais — a Bybit não dá base de custo por lote).

Garantias: **read-only** (o worker só permite endpoints de leitura e só `GET` —
nunca coloca ordens), o **segredo vive no worker** (nunca no repo, browser, UI ou
logs), protegido por token de acesso e CORS restrito. Sem isto configurado, o site
funciona na mesma em **modo manual**. Instruções em [`proxy/README.md`](proxy/README.md).

---

## Modelos e fórmulas (honestidade dos números)

- **Liquidação** (perps): aproximada, margem isolada, exclui taxas e margem de
  manutenção real — na prática liquida antes.
- **P&L linear vs inverso**: fórmulas distintas (linear USDT-margined; inverso
  coin-margined, não-linear na margem/ROI). Funding subtraído ao P&L bruto.
- **Custo médio**: mostra "como estás", **não** serve para decidir vendas — para
  isso usa a vista de **Lotes** (365 dias + FIFO).
- **365 dias**: mais-valias de cripto spot detida ≥ 365 dias são isentas; abaixo,
  28%. Lote a lote, cada compra com o seu relógio; FIFO na venda.
- **Derivados**: não contam para os 365 dias; tributados à parte; P&L separado.
- **PPR**: fiscalidade própria; **titularidade distinta** (Patrícia) — nunca
  somada à minha.
- **Cenários**: comparação relativa sobre a mesma trajetória. **Nunca** previsão.
- **DAC8**: a Bybit reporta à AT. Nota informativa na secção fiscal.

---

## Arquitetura

Site estático, sem backend. Tudo corre no browser:

```
index.html     estrutura + navegação
styles.css     tema de consola (escuro, monospace tabular, liquidação a vermelho)
engine.js      cálculo puro: escada, mNAV, perps (linear/inverso), fiscal (365d/FIFO), cenários
store.js       persistência local (localStorage) + seed + export/import
data.js        APIs públicas do lado do cliente, com degradação para manual
app.js         vistas/UI (dashboard, tracker, lotes, inversos, cenários, ppr, definições)
```

O `engine.js` é uma porta fiel (paridade de fórmulas) de um motor validado por
testes, verificada a correr num browser real (custo médio, escada, FIFO/365 dias
e estimativa de imposto batem certo).

Publicação: GitHub Pages a servir a raiz do repositório.
