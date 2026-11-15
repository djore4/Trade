# Acesso e segurança

Uso pessoal. Todas as Edge Functions do Asset Manager exigem o header `x-am-secret`
(= secret `AM_SECRET`). **Sem `AM_SECRET` configurado, recusam tudo (503).** A publishable key
está no JS público e não autentica nada. Código em `supabase/functions/_shared/auth.ts`.

O projeto Supabase é partilhado com outras apps (demos/viaturas, prospec, sf-*, admin-users…).
Essas funções e tabelas **não foram tocadas** — rever à parte.

## Ordem de ativação (segura — nada deixa de funcionar a meio)
1. Gerar o segredo: `openssl rand -base64 32`.
2. Supabase → Edge Functions → Secrets: `AM_SECRET=<segredo>`.
3. SQL editor: `select vault.create_secret('<segredo>', 'am_secret');`
4. Aplicar `migrations/20261115_am_secret_cron.sql` (os crons passam a enviar o header).
5. Deploy das funções (todas as de `supabase/functions/*`, incl. `trade-advisor`, que agora vive no repo).
   Manter as flags de JWT atuais (`--no-verify-jwt` nas que já o têm).
6. Publicar o front-end; no 1.º acesso a app pede o código (fica em localStorage do dispositivo).

## Rotação
Mudar `AM_SECRET` (secret + vault: `select vault.update_secret(id, '<novo>', 'am_secret')`) e voltar a
introduzir o código nos dispositivos (a app pede-o sozinha ao receber 401).

## Limitações conhecidas
- Segredo único e estático: sem expiração nem revogação por dispositivo. Aceitável para uso pessoal.
- CORS continua `*` (o controlo é o segredo, não a origem).
- "Modo demonstração" é só visual; os dados chegam em claro ao dispositivo autenticado.

---

# Análise (desempenho real, diário, risco, briefing)

Código novo: `lib/perf.js` (cálculo puro, testado: `node --test tests/perf.test.js`),
migração `supabase/migrations/20261116_am_analytics.sql`, funções `am-data`, `am-journal`,
`am-brief`, `get-etf-holdings` e o separador **Análise** na app.

## Ativação (depois da segurança acima)
1. Aplicar `20261116_am_analytics.sql` (cria tabelas e 4 crons: snapshot 4/4h, fluxos diário, diário horário, briefing 07:30 UTC).
2. Deploy: `am-data`, `am-journal`, `am-brief`, `get-etf-holdings` (e o resto, que mudou por causa do `AM_SECRET`).
3. Secrets opcionais: `BRIEF_MODEL` (por defeito `claude-sonnet-5-5`). `ANTHROPIC_API_KEY` já é usada pela `trade-advisor`.
4. Na app → Análise → Desempenho: **Registar agora**, depois **Importar depósitos/levantamentos**; em Diário: **Importar 1 ano**.

## O que NÃO está validado contra dados reais (ninguém testou com as tuas contas)
- Formato das respostas da Bybit (`closed-pnl`, registos de depósito/levantamento) e da T212 (`transactions`, `dividends`): escrito pela documentação; se algum campo diferir, a importação devolve avisos em vez de gravar lixo.
- `closedPnl` da Bybit: confirmar se já desconta comissões (a app mostra as comissões à parte, sem as subtrair de novo).
- Look-through de ETFs: depende de um endpoint não oficial do Yahoo; pode falhar (a app mostra "indisponível").
- Depósitos feitos com cartão/P2P não aparecem nos registos da Bybit: adiciona-os como fluxo manual, senão contam como lucro.

## Decisões deliberadas
- Sem histórico reconstruído: a curva real começa no 1.º snapshot. Um passado inventado seria pior do que nenhum.
- O snapshot **recusa gravar** se uma fonte falhar (evita quedas falsas no gráfico).
- Retorno por Modified Dietz encadeado, não TWR "puro" (precisaria do valor exato no instante de cada fluxo).

## Regra de ouro ao ativar a guarda função a função
O front-end só envia `x-am-secret` às funções listadas em `GUARDED` (`index.html`). As versões antigas não o têm
nos headers CORS permitidos, por isso o browser **bloqueia o pedido real** se o header for enviado.
Ao redeployar uma função com a guarda, acrescenta o nome dela a `GUARDED` **no mesmo PR/merge**.
(Bug real de 15/11/2026: o front-end enviou o header a todas as funções antes de estas serem redeployadas e a app
deixou de carregar dados. Os testes com `page.route` não o apanham — o Playwright responde sozinho ao preflight.)
