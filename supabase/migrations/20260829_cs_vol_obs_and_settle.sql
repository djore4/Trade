-- Validação de edge do scanner de volatilidade.
-- cs_vol_obs: TODOS os pares avaliados em cada scan (grupo de controlo).
-- cs-vol-settle mede a expansão realizada no horizonte (obs_horizon_h, 4h) e o
-- score↔vol futura fica testável (correlação / decis, out-of-sample).

create table if not exists public.cs_vol_obs (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  symbol        text not null,
  coin          text,
  score         numeric,
  price         numeric,
  bb_h1         numeric,
  atr_pct       numeric,
  exp_move      numeric,
  above_alert   boolean,
  horizon_h     numeric,
  fwd_high      numeric,
  fwd_low       numeric,
  realized_move numeric,
  realized_up   numeric,
  realized_dn   numeric,
  settled_at    timestamptz
);
create index if not exists cs_vol_obs_pending on public.cs_vol_obs (ts) where settled_at is null;
create index if not exists cs_vol_obs_symbol on public.cs_vol_obs (symbol, ts desc);
alter table public.cs_vol_obs enable row level security;

alter table public.cs_config add column if not exists obs_horizon_h numeric not null default 4;

-- Cron: settle das observações a cada 15 min.
select cron.schedule(
  'cs-vol-settle-15m',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/cs-vol-settle',
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
