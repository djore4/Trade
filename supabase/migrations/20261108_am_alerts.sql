-- Asset Manager: subscrições Web Push e alertas (preço e distância à liquidação).
-- Tabelas fechadas (RLS sem policies): só as edge functions (service role) leem/escrevem.
-- As chaves VAPID reutilizam public.cs_config (já existente); as subscrições têm tabela própria
-- para não misturar com os avisos do antigo CryptoScan (cs_push_subs).
create table if not exists public.am_push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  fail_count int not null default 0
);

create table if not exists public.am_alerts (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('price', 'liq')),
  source        text not null check (source in ('bybit', 'yahoo')),
  symbol        text not null,
  label         text,
  op            text check (op in ('above', 'below')),
  level         numeric not null check (level > 0),
  repeat        boolean not null default false,
  active        boolean not null default true,
  armed         boolean not null default true,
  created_at    timestamptz not null default now(),
  triggered_at  timestamptz,
  trigger_value numeric,
  constraint am_alerts_price_op check (kind <> 'price' or op is not null)
);
create index if not exists am_alerts_active on public.am_alerts (active) where active;

alter table public.am_push_subs enable row level security;
alter table public.am_alerts enable row level security;
revoke all on public.am_push_subs from anon, authenticated;
revoke all on public.am_alerts from anon, authenticated;
comment on table public.am_alerts is 'Asset Manager: alertas de preço (kind=price) e de distância à liquidação (kind=liq, level em %).';

-- Cron: avalia os alertas todos os minutos (chama a edge function am-alerts-check, verify_jwt=false).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'am-alerts-1m',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/am-alerts-check',
       headers := jsonb_build_object('Content-Type', 'application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 55000
     ); $$
);
