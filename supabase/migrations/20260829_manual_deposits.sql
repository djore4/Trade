-- ===========================================================================
-- Depósitos manuais — livro de entradas para o "return real" do portefólio.
--
-- Porquê: o return da home é reconstruído do histórico de ordens spot da Bybit
-- (computeAvgPrices). Moedas que entraram por DEPÓSITO/TRANSFERÊNCIA não têm
-- ordem nenhuma -> não têm base de custo -> o return fica fantasma (0% ou
-- inflado). Este livro guarda, por moeda, o capital REAL investido (€/$) e a
-- quantidade de cripto que esse depósito comprou, permitindo:
--
--     return = (valor de mercado atual da qtd)  −  capital investido
--              ───────────────────────────────────────────────────────
--                              capital investido
--
-- Acesso: tabela ABERTA à publishable key (role anon), tal como exit_targets
-- — é um portefólio pessoal de utilizador único, sem PII. O cliente lê/escreve
-- por PostgREST diretamente (SUPABASE_REST), sem edge function.
--
-- Aplicar via: supabase db push  (ou apply_migration). NÃO corre sozinho.
-- ===========================================================================

create table if not exists public.manual_deposits (
  id          uuid        primary key default gen_random_uuid(),
  coin        text        not null,                         -- símbolo (ex.: 'ADA', 'BTC')
  qty         numeric     not null check (qty > 0),         -- qtd de cripto que o depósito comprou
  paid        numeric     not null check (paid >= 0),       -- valor pago (na moeda 'currency')
  currency    text        not null default 'EUR' check (currency in ('EUR', 'USD')),
  ts          timestamptz not null default now(),           -- data do depósito
  note        text,                                         -- nota opcional
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists manual_deposits_coin_idx on public.manual_deposits (coin);
create index if not exists manual_deposits_ts_idx   on public.manual_deposits (ts);

alter table public.manual_deposits enable row level security;

-- Aberta ao role anon (publishable key) e authenticated — portefólio pessoal.
drop policy if exists manual_deposits_all on public.manual_deposits;
create policy manual_deposits_all on public.manual_deposits
  for all
  to anon, authenticated
  using (true)
  with check (true);
