-- Features de DIREÇÃO (momentum multi-TF) + desfechos direcionais em cs_vol_obs.
-- Registamos por observação; o cs-vol-settle preenche os desfechos após o
-- horizonte. Objetivo: testar OOS que features preveem a direção — sem inventar
-- a fórmula à mão (deixar os dados escolher), como fizemos para a volatilidade.
alter table public.cs_vol_obs
  add column if not exists ret_1h     numeric,   -- retorno 1h (%)
  add column if not exists ret_4h     numeric,   -- retorno 4h (%)
  add column if not exists ret_24h    numeric,   -- retorno 24h (%)
  add column if not exists ema20_rel  numeric,   -- (preço - EMA20 1h)/EMA20 (%)
  add column if not exists ema50_rel  numeric,   -- (preço - EMA50 1h)/EMA50 (%)
  add column if not exists di_dir     numeric,   -- +DI menos -DI (>0 = tendência up)
  add column if not exists adx        numeric,   -- força da tendência
  add column if not exists range_hi   numeric,   -- topo do range 6h (para 1ª rutura)
  add column if not exists range_lo   numeric,   -- fundo do range 6h
  -- desfechos direcionais (preenchidos pelo settle):
  add column if not exists fwd_close  numeric,   -- fecho no horizonte
  add column if not exists ret_fwd    numeric,   -- retorno líquido no horizonte (%)
  add column if not exists first_break text;     -- 'up' | 'down' | 'both' | 'none'
