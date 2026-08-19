-- =====================================================
-- VIEWS DIÁRIAS — três colunas em `domains`
--
-- Rode no SQL Editor do Supabase ANTES de subir o deploy. Sem elas o coletor
-- roda, consulta o Cloudflare e falha na gravação, domínio por domínio.
--
-- Preenchidas 1x por dia pelo cron de src/services/cloudflare/analytics.js.
--
-- NULL significa "não medido", nunca "sem acesso". Domínio fora do Cloudflare
-- — 169 ativos, quase todos AtomiCat na BunnyCDN — nunca é tocado e permanece
-- NULL. Gravar zero neles repetiria o erro que `monthly_visits` já comete, onde
-- 1.054 domínios aparecem com 0 por ausência de origem, não por falta de tráfego.
--
-- A unidade é REQUISIÇÃO, igual a `monthly_visits` — cada arquivo servido, não
-- carregamento de página. Ver o cabeçalho de analytics.js para a medição que
-- estabeleceu isso.
-- =====================================================

alter table public.domains
  add column if not exists views_14d      bigint,
  add column if not exists last_view_date date,
  add column if not exists views_last_day bigint;

comment on column public.domains.views_14d is
  'Requisições nos últimos 14 dias fechados (Cloudflare). NULL = domínio sem zona, não medido.';

comment on column public.domains.last_view_date is
  'Último dia com requisição > 0 nos 14 dias apurados. NULL = sem medição ou sem acesso no período.';

comment on column public.domains.views_last_day is
  'Requisições no dia indicado por last_view_date.';

-- Conferência: deve devolver as três linhas.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'domains'
  and column_name in ('views_14d', 'last_view_date', 'views_last_day')
order by column_name;
