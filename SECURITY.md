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
