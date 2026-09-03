-- ===========================================================================
-- BTC Advisor — derivação BTC-only do CryptoScan (FASE 1).
-- ===========================================================================
-- Filosofia idêntica ao cs_vol_obs: NÃO confiar na direção antes de a medir OOS.
-- O btc-scan (cron) corre o motor enriquecido (momentum/estrutura da Bybit +
-- posicionamento exclusivo de BTC: opções Deribit, basis, funding multi-venue)
-- e regista uma OBSERVAÇÃO por scan × horizonte. O btc-settle mede o desfecho
-- direcional realizado após o horizonte. A app mostra a expectância acumulada
-- rotulada "não validado" até haver amostra. O CryptoScan fica intacto.
--
-- Dois horizontes por scan:
--   • intraday — reutiliza cs_config.obs_horizon_h (4h por defeito).
--   • swing    — cs_config.btc_swing_horizon_h (72h por defeito).
--
-- Aplicar via: supabase db push  (ou apply_migration). NÃO corre sozinho.
-- ===========================================================================

-- Horizonte do modo swing (o intraday reutiliza obs_horizon_h já existente).
alter table public.cs_config
  add column if not exists btc_swing_horizon_h numeric not null default 72;

-- ---------------------------------------------------------------------------
-- Observações do advisor de BTC (grupo de controlo direcional).
-- FECHADA (RLS on, sem policies) — só o service role das edge functions escreve.
-- ---------------------------------------------------------------------------
create table if not exists public.btc_obs (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  horizon       text        not null check (horizon in ('intraday','swing')),
  horizon_h     numeric,                    -- horas do horizonte no momento do registo

  -- decisão emitida (o que o tab aconselharia neste instante)
  dir           integer,                    -- -1 short | 0 neutro | +1 long
  score         numeric,                    -- score composto (momentum+posicionamento)
  confidence    numeric,                    -- 1-10
  setup         text,                       -- rótulo do setup dominante
  price         numeric,                    -- preço de referência (entry)
  stop          numeric,
  tp1           numeric,
  tp1_r         numeric,
  stop_pct      numeric,
  blended_rr    numeric,

  -- backbone (motor base, Bybit) — para separar o efeito das features BTC
  base_dir      integer,
  base_score    numeric,
  regime        text,
  adx           numeric,

  -- ── features EXCLUSIVAS de BTC (a testar; podem vir nulas se a fonte falhar) ──
  dvol          numeric,                    -- índice de vol implícita (Deribit DVOL)
  dvol_pct      numeric,                    -- percentil do DVOL na janela
  iv_skew       numeric,                    -- proxy 25Δ: IV puts OTM − IV calls OTM (pp)
  iv_term       numeric,                    -- estrutura a prazo: IV próxima − IV seguinte (pp)
  put_call_oi   numeric,                    -- rácio de OI puts/calls (posicionamento opções)
  funding_agg   numeric,                    -- funding médio multi-venue (%/8h)
  funding_disp  numeric,                    -- dispersão do funding entre venues (desacordo)
  basis_perp    numeric,                    -- prémio perp-spot (%)
  basis_fut     numeric,                    -- basis do futuro trimestral anualizado (%)
  pos_tilt      numeric,                    -- voto de posicionamento agregado (-1..+1)

  -- ── desfechos (preenchidos pelo settle) ──
  fwd_close     numeric,                    -- fecho no horizonte
  ret_fwd       numeric,                    -- retorno líquido no horizonte (%)
  mfe           numeric,                    -- excursão favorável máx (%) na direção emitida
  mae           numeric,                    -- excursão adversa máx (%) na direção emitida
  hit_dir       boolean,                    -- ret_fwd teve o sinal da direção emitida?
  r_realized    numeric,                    -- R realizado (mfe/mae vs stop; líquido aproximado)
  settled_at    timestamptz
);
create index if not exists btc_obs_pending on public.btc_obs (ts) where settled_at is null;
create index if not exists btc_obs_horizon on public.btc_obs (horizon, ts desc);
alter table public.btc_obs enable row level security;

-- ---------------------------------------------------------------------------
-- Crons: scan (registo) a cada 15 min; settle (desfecho) a cada 15 min.
-- Usam a publishable key como as restantes edge functions do projeto.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'btc-scan-15m',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/btc-scan',
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

select cron.schedule(
  'btc-settle-15m',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://yifxgiwmibjaornighvt.supabase.co/functions/v1/btc-settle',
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
