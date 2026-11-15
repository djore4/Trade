-- Os crons passam a autenticar-se com o AM_SECRET (guardado no Supabase Vault,
-- nunca no repo). PRÉ-REQUISITO — criar o segredo UMA vez (valor = o mesmo AM_SECRET das Edge Function secrets):
--   select vault.create_secret('<AM_SECRET>', 'am_secret');
-- Sem ele, os crons enviam o header vazio e as funções respondem 401 (falha fechada).
-- cron.schedule com o mesmo jobname atualiza o job existente. Não toca no job prospec-push (outra app).

select cron.schedule('cs-settle-every-15min', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/cs-settle',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{}'::jsonb, timeout_milliseconds := 120000); $$);

select cron.schedule('cs-vol-scan-15m', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/cs-vol-scan',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{}'::jsonb, timeout_milliseconds := 120000); $$);

select cron.schedule('cs-vol-settle-15m', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/cs-vol-settle',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{}'::jsonb, timeout_milliseconds := 120000); $$);

select cron.schedule('am-alerts-1m', '* * * * *', $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/am-alerts-check',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{}'::jsonb, timeout_milliseconds := 55000); $$);

-- Higiene: a tabela manual_deposits (se existir) não deve ser acessível com a publishable key.
do $$ begin
  if to_regclass('public.manual_deposits') is not null then
    drop policy if exists manual_deposits_all on public.manual_deposits;
    revoke all on public.manual_deposits from anon, authenticated;
  end if;
end $$;
