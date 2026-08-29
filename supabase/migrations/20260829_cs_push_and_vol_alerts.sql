-- Web Push + scanner de volatilidade (alertas).
-- NOTA: as chaves VAPID (cs_config.vapid_public/private) NÃO estão neste repo —
-- são inseridas diretamente na base (a privada é segredo). Ver cs-vol-scan.

create table if not exists public.cs_push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  fail_count int not null default 0
);
alter table public.cs_push_subs enable row level security;

create table if not exists public.cs_vol_alerts (
  id            bigint generated always as identity primary key,
  sig_key       text unique,
  ts            timestamptz not null default now(),
  symbol        text not null,
  coin          text,
  score         numeric,
  exp_move      numeric,
  bb_h1         numeric,
  atr_pct       numeric,
  adx           numeric,
  nr7           boolean,
  inside        boolean,
  range_lo      numeric,
  range_hi      numeric,
  price         numeric,
  tilt          text,
  turnover      numeric,
  low_liq       boolean,
  realized_move numeric,
  expanded      boolean,
  settled_at    timestamptz
);
create index if not exists cs_vol_alerts_symbol_ts on public.cs_vol_alerts (symbol, ts desc);
alter table public.cs_vol_alerts enable row level security;

create table if not exists public.cs_config (
  id                int primary key default 1,
  vapid_public      text,
  vapid_private     text,
  vapid_subject     text default 'mailto:alerts@cryptoscan.local',
  vol_threshold     numeric not null default 72,
  alert_dedup_hours numeric not null default 6,
  universe_top      int not null default 70,
  updated_at        timestamptz not null default now(),
  constraint cs_config_singleton check (id = 1)
);
alter table public.cs_config enable row level security;
insert into public.cs_config (id) values (1) on conflict (id) do nothing;

-- Cron: scanner de volatilidade a cada 15 min (chama a edge function cs-vol-scan).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'cs-vol-scan-15m',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/cs-vol-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xHjsFJbSuAhO6r6BUylTCw_tDE-nFXT',
      'Authorization', 'Bearer sb_publishable_xHjsFJbSuAhO6r6BUylTCw_tDE-nFXT'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
