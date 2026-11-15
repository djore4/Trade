-- Asset Manager: definições da análise. analysis_start = data a partir da qual a Análise conta; as funções am-data e
-- am-journal não importam nem devolvem nada anterior (e settings_set apaga o que já lá estava). Aplicada em produção via MCP.
create table if not exists public.am_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.am_settings enable row level security;
revoke all on public.am_settings from anon, authenticated;
comment on table public.am_settings is 'Asset Manager: definições da análise (ex.: analysis_start). Só edge functions (service role).';
insert into public.am_settings (key, value) values ('analysis_start', to_jsonb('2024-12-10T10:40:25.296Z'::text))
on conflict (key) do nothing;
