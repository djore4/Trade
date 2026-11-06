-- Cache partilhada (so acessivel com service role) para respostas lentas/limitadas de APIs externas (Trading 212).
-- Usada por supabase/functions/get-t212-portfolio. Sem policies: anon/authenticated nao leem nem escrevem.
create table if not exists public.pf_cache (
  k text primary key,
  v jsonb not null,
  at timestamptz not null default now()
);
alter table public.pf_cache enable row level security;
revoke all on public.pf_cache from anon, authenticated;
comment on table public.pf_cache is 'Cache servidor (service role) de respostas da T212: portfolio e instrumentos.';
