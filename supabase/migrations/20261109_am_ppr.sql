-- Asset Manager: PPR introduzidos manualmente (sincronizados entre dispositivos).
-- Linha única; `rev` serve de controlo de concorrência (só grava quem viu a revisão atual).
-- Tabela fechada (RLS sem policies): só a edge function am-ppr (service role) lê/escreve.
create table if not exists public.am_ppr (
  id         int primary key default 1,
  data       jsonb not null default '{"funds":[]}'::jsonb,
  rev        int not null default 0,
  updated_at timestamptz not null default now(),
  constraint am_ppr_singleton check (id = 1)
);
alter table public.am_ppr enable row level security;
revoke all on public.am_ppr from anon, authenticated;
insert into public.am_ppr (id) values (1) on conflict (id) do nothing;
comment on table public.am_ppr is 'Asset Manager: PPR (fundos, compras e valor da unidade) introduzidos manualmente.';
