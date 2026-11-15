-- Asset Manager · análise: snapshots (retorno real), fluxos de capital, diário de trades,
-- teses, briefings. Tabelas fechadas (RLS sem policies): só edge functions (service role).

-- 1) Snapshots do valor total (cron a cada 4h). Guarda cada fonte na moeda nativa + câmbio.
create table if not exists public.am_snapshots (
  ts         timestamptz primary key default now(),
  total_eur  numeric not null,
  total_usd  numeric not null,
  bybit_usd  numeric,
  t212_val   numeric,
  t212_ccy   text,
  ppr_eur    numeric not null default 0,
  eurusd     numeric not null,           -- USD por 1 EUR no momento
  partial    boolean not null default false
);
alter table public.am_snapshots enable row level security;
revoke all on public.am_snapshots from anon, authenticated;

-- 1b) Fluxos de capital externos (depósitos +, levantamentos −), em EUR e USD.
create table if not exists public.am_flows (
  id      text primary key,               -- 'bybit:dep:<txid>' | 't212:<ref>' | 'manual:<uuid>'
  ts      timestamptz not null,
  source  text not null check (source in ('bybit','t212','ppr','manual')),
  eur     numeric not null,               -- + entrada de capital, − saída
  usd     numeric not null,
  coin    text,
  note    text,
  auto    boolean not null default true
);
create index if not exists am_flows_ts on public.am_flows (ts);
alter table public.am_flows enable row level security;
revoke all on public.am_flows from anon, authenticated;

-- 2) Diário: operações fechadas (Bybit closed-pnl, linear) + etiquetas do utilizador.
create table if not exists public.am_trades (
  id        text primary key,             -- orderId do fecho
  symbol    text not null,
  side      text not null check (side in ('long','short')),
  qty       numeric, entry numeric, exit numeric,
  pnl       numeric not null,
  fees      numeric not null default 0,
  lev       numeric,
  opened_at timestamptz, closed_at timestamptz not null,
  tag       text, note text
);
create index if not exists am_trades_closed on public.am_trades (closed_at desc);
alter table public.am_trades enable row level security;
revoke all on public.am_trades from anon, authenticated;

-- 4) Teses: o porquê da posição + o nível que a invalida (liga a um alerta de preço).
create table if not exists public.am_theses (
  id         bigint generated always as identity primary key,
  symbol     text not null,
  source     text not null default 'bybit' check (source in ('bybit','yahoo')),
  side       text check (side in ('long','short')),
  thesis     text not null,
  invalid_px numeric check (invalid_px > 0),
  alert_id   bigint,
  status     text not null default 'open' check (status in ('open','closed','invalidated')),
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
alter table public.am_theses enable row level security;
revoke all on public.am_theses from anon, authenticated;

-- 4b) Briefings gerados pela IA.
create table if not exists public.am_briefs (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null default 'daily',
  body       text not null,
  pushed     int not null default 0
);
alter table public.am_briefs enable row level security;
revoke all on public.am_briefs from anon, authenticated;

-- Crons (autenticam-se com o segredo do Vault 'am_secret' — ver 20261115_am_secret_cron.sql).
select cron.schedule('am-snapshot-4h', '5 */4 * * *', $$
  select net.http_post(url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/am-data',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{"action":"snapshot"}'::jsonb, timeout_milliseconds := 60000); $$);

select cron.schedule('am-flows-daily', '20 5 * * *', $$
  select net.http_post(url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/am-data',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{"action":"flows_sync"}'::jsonb, timeout_milliseconds := 120000); $$);

select cron.schedule('am-journal-hourly', '10 * * * *', $$
  select net.http_post(url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/am-journal',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{"action":"sync","days":3}'::jsonb, timeout_milliseconds := 60000); $$);

select cron.schedule('am-brief-daily', '30 7 * * *', $$
  select net.http_post(url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/am-brief',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-am-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='am_secret'), '')),
    body := '{"action":"run"}'::jsonb, timeout_milliseconds := 120000); $$);

-- Leitura do segredo pelas edge functions (alternativa ao secret AM_SECRET do painel): só a service role executa.
create or replace function public.am_secret() returns text
  language sql security definer stable set search_path = ''
  as $$ select decrypted_secret from vault.decrypted_secrets where name = 'am_secret' limit 1 $$;
revoke all on function public.am_secret() from public, anon, authenticated;
grant execute on function public.am_secret() to service_role;
