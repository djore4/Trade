# CryptoScan Bot — execução semi-automática na Bybit

Loop que corre o **mesmo motor da app** (`_shared/cs-engine.ts`, portado 1:1 de
`index.html`) do lado do servidor, filtra por convicção e **enfileira** os
melhores candidatos para **confirmação humana** antes de colocar ordens numa
**AI subaccount** da Bybit.

```
cs-bot (cron)          cs-confirm (humano)         cs-order                 cs-settle (cron já existente)
 corre o motor   ──▶   confirma/rejeita     ──▶    coloca na Bybit    ──▶    pontua o desfecho real
 → cs_bot_orders       → status confirmed          → cs_suggestions         (loop de feedback que já tens)
   (pending_confirm)                                  (status open)
```

## Peças

| Ficheiro | Papel |
|---|---|
| `_shared/cs-engine.ts` | Motor puro: sinais, regime, scoring, risk engine, recalibração (`buildConfig({recalibrate})`). |
| `_shared/bybit.ts` | Cliente v5 assinado (GET/POST) + filtros do instrumento + arredondamento ao passo/tick. |
| `cs-bot/index.ts` | Cron: scan → filtra → enfileira em `cs_bot_orders`. |
| `cs-confirm/index.ts` | Gate humano: lista pendentes (GET) e confirma/rejeita (POST). |
| `cs-order/index.ts` | Coloca uma ordem confirmada; revalida guarda-costas; grava em `cs_suggestions`. |
| `migrations/20260823_cs_bot.sql` | Tabelas `cs_bot_state` (interruptores/limites) e `cs_bot_orders` (fila). |

## Pré-requisitos (ação do utilizador)

1. **AI subaccount na Bybit** + API key/secret dessa subconta com permissão
   **Trade** (de preferência restrita por IP). **Contas em modo one-way**
   (o `cs-order` usa `positionIdx: 0`).
2. **Secrets do Supabase** (Dashboard → Edge Functions → Secrets):
   - `BYBIT_SUB_API_KEY` — a API key da subconta (sempre).
   - **Autenticação — escolhe UMA:**
     - **RSA (recomendado):** `BYBIT_SUB_API_PRIVATE_KEY` = chave privada PEM
       (PKCS#8). Ao criar a API key na Bybit escolhes tipo **RSA** e colas a
       chave *pública*. O `_shared/bybit.ts` deteta a privada e assina com
       RSASSA-PKCS1-v1_5/SHA-256 (`X-BAPI-SIGN-TYPE: 2`). O segredo nunca sai
       do Supabase.
     - **HMAC (alternativa):** `BYBIT_SUB_API_SECRET` = o secret gerado pela
       Bybit. Usado se não houver chave privada RSA.
   - `BYBIT_BASE` — opcional (default `https://api.bybit.com`).
   - `CS_BOT_SECRET` — opcional; se definido, `cs-confirm` exige-o no header
     `x-cs-secret` (protege a confirmação de quem tenha só a anon key).

## Deploy

```bash
# esquema
supabase db push                       # aplica migrations/20260823_cs_bot.sql

# funções
supabase functions deploy cs-bot
supabase functions deploy cs-order
supabase functions deploy cs-confirm
```

## Cron (pg_cron) — mesmo padrão do cs-settle

```sql
-- corre o loop de 15 em 15 min (ajusta ao teu gosto)
select cron.schedule('cs-bot', '*/15 * * * *', $$
  select net.http_post(
    url    := 'https://<PROJECT>.supabase.co/functions/v1/cs-bot',
    headers:= jsonb_build_object('Content-Type','application/json','Authorization','Bearer <ANON_OR_SERVICE_KEY>'),
    body   := '{}'::jsonb
  );
$$);
```

## Sequência de arranque SEGURA (mainnet, dinheiro real)

O estado começa **travado**: `enabled=false`, `dry_run=true`, `auto_confirm=false`,
`sensitivity=strict`, `recalibrate=true`, `leverage=5`, limites conservadores.

1. **Dry-run.** `enabled=true`, mantém `dry_run=true`. O loop enfileira e o
   `cs-order` **nunca** coloca (marca `cancelled` com `error='dry_run'`).
   Confirma que os candidatos, sizing e SL/TP fazem sentido.
   ```sql
   update cs_bot_state set enabled=true where id=1;
   ```
2. **Primeira ordem real, semi-auto.** `dry_run=false`, `auto_confirm=false`.
   Cada ordem espera a tua confirmação em `cs-confirm`. Capital simbólico.
   ```sql
   update cs_bot_state set dry_run=false where id=1;
   ```
3. **Escalar devagar.** Sobe `capital`, `leverage`, `max_open_positions` só
   depois de veres desfechos reais. Considera `auto_confirm=true` apenas
   quando confiares no funil.

## Kill-switch

```sql
update cs_bot_state set killswitch=true where id=1;   -- pára tudo já
```
`cs-bot` e `cs-order` verificam `killswitch` no início e abortam.

## Guarda-costas (em `cs_bot_state`)

| Campo | Default | O quê |
|---|---|---|
| `killswitch` | false | Paragem de emergência (vence tudo). |
| `dry_run` | true | Enfileira mas nunca coloca. |
| `auto_confirm` | false | false = humano confirma cada ordem. |
| `max_open_positions` | 2 | Teto de posições simultâneas (reconciliado com a Bybit). |
| `max_daily_orders` | 4 | Ordens colocadas por dia UTC. |
| `max_daily_risk_usd` | 10 | Soma de risco ($) colocado por dia UTC. |
| `max_notional_usd` | 600 | Teto de notional por ordem. |
| `confirm_ttl_min` | 30 | Validade de uma ordem pendente (o preço envelhece). |

Dedup: índice único em `cs_bot_orders.sig_key` (1 por moeda/lado/hora), mais
`orderLinkId=sig_key` do lado da Bybit (idempotência na exchange).
