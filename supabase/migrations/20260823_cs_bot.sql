-- ===========================================================================
-- CryptoScan Bot — esquema da execução semi-automática na subconta Bybit.
-- Duas tabelas, ambas FECHADAS (RLS on, sem policies = só service role
-- via edge functions lá chega), tal como cs_suggestions.
--
--   cs_bot_state  — linha única (id=1): interruptores e limites de risco.
--   cs_bot_orders — fila de ordens: pending_confirm → confirmed → placed
--                   (ou rejected/cancelled/failed/expired).
--
-- Aplicar via: supabase db push  (ou apply_migration). NÃO corre sozinho.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Estado do bot + guarda-costas (single-row switchboard).
-- ---------------------------------------------------------------------------
create table if not exists public.cs_bot_state (
  id                  smallint primary key default 1,
  enabled             boolean  not null default false,  -- master on/off do loop
  killswitch          boolean  not null default false,  -- paragem de emergência (vence tudo)
  dry_run             boolean  not null default true,   -- true = enfileira mas NUNCA coloca ordem
  auto_confirm        boolean  not null default false,  -- false = semi-auto (humano confirma)
  -- limites de risco (mainnet, dinheiro real → defaults conservadores)
  capital             numeric  not null default 100,    -- capital de referência p/ sizing (USD)
  leverage            integer  not null default 5,      -- alavancagem-alvo (baixa por defeito)
  sensitivity         text     not null default 'strict',
  recalibrate         boolean  not null default true,   -- usa os pesos recalibrados
  min_confidence      numeric,                          -- override opcional da fasquia de confiança
  max_open_positions  integer  not null default 2,      -- nº máx de posições simultâneas
  max_daily_orders    integer  not null default 4,      -- nº máx de ordens colocadas por dia UTC
  max_daily_risk_usd  numeric  not null default 10,     -- soma máx de risco ($) aberto por dia UTC
  max_notional_usd    numeric  not null default 600,    -- teto de notional por ordem
  confirm_ttl_min     integer  not null default 30,     -- validade de uma ordem pending_confirm (min)
  constraint cs_bot_state_singleton check (id = 1)
);

insert into public.cs_bot_state (id) values (1) on conflict (id) do nothing;

alter table public.cs_bot_state enable row level security;

-- ---------------------------------------------------------------------------
-- Fila de ordens do bot.
-- ---------------------------------------------------------------------------
create table if not exists public.cs_bot_orders (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  sig_key        text        not null,               -- dedup: symbol_side_YYYYMMDDHH
  entry_ts       timestamptz not null,
  symbol         text        not null,
  coin           text        not null,
  side           text        not null check (side in ('long','short')),
  -- plano de trade (snapshot no momento da decisão)
  entry          double precision not null,
  stop           double precision not null,
  tp1            double precision not null,
  tp2            double precision,
  tp3            double precision,
  tp1_r          double precision,
  stop_pct       double precision,
  blended_rr     double precision,
  qty            double precision not null,           -- quantidade base a enviar à Bybit
  notional       double precision,
  leverage       double precision,
  risk_usd       double precision,
  -- contexto do sinal
  score          double precision,
  confidence     double precision,
  sensitivity    text,
  regime         text,
  setup          text,
  signals        jsonb,
  turnover       double precision,
  low_liq        boolean not null default false,
  recalibrated   boolean not null default false,
  -- ciclo de vida
  status         text not null default 'pending_confirm'
                 check (status in ('pending_confirm','confirmed','placing','placed',
                                   'rejected','cancelled','failed','expired')),
  bybit_order_id text,
  order_link_id  text,                                -- idempotência do lado da Bybit
  error          text,
  confirmed_at   timestamptz,
  placed_at      timestamptz,
  decided_by     text                                 -- 'human' | 'auto' | null
);

-- Um sig_key só entra na fila uma vez (dedup por moeda/lado/hora).
create unique index if not exists cs_bot_orders_sig_key_uidx on public.cs_bot_orders (sig_key);
create index if not exists cs_bot_orders_status_idx on public.cs_bot_orders (status);
create index if not exists cs_bot_orders_created_idx on public.cs_bot_orders (created_at desc);

alter table public.cs_bot_orders enable row level security;
