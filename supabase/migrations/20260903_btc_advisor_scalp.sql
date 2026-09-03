-- BTC Advisor — terceiro horizonte "scalp" (~2h). Desfechos independentes mais
-- depressa (o gargalo da validação é o horizonte, não a frequência do scan).
alter table public.cs_config
  add column if not exists btc_scalp_horizon_h numeric not null default 2;

-- Alargar o CHECK do horizonte para aceitar 'scalp'.
alter table public.btc_obs drop constraint if exists btc_obs_horizon_check;
alter table public.btc_obs
  add constraint btc_obs_horizon_check check (horizon in ('scalp','intraday','swing'));
