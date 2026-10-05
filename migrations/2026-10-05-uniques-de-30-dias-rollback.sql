-- =====================================================
-- REVERSA DE 2026-10-05-uniques-de-30-dias.sql
--
-- APAGA DADO: os três valores de 30 dias de todos os domínios. São
-- reconstruídos na próxima rodada do coletor, desde que o código da quarta
-- consulta ainda esteja lá — na prática a perda é de menos de um dia.
--
-- ORDEM: reverta o CÓDIGO primeiro, nos dois repositórios. Com as colunas
-- fora e o coletor ainda tentando escrevê-las, o `update` falha e leva junto
-- as CINCO colunas de 14 dias e as três do mês corrente — todas vão no mesmo
-- comando. Isso derrubaria a aba Críticos e o CSV, que é muito pior do que o
-- problema que a reversa estaria resolvendo.
--
-- Se o motivo da reversa for cota da Cloudflare e não as colunas, há uma
-- saída mais barata: subir PAUSA_ENTRE_CONSULTAS em analytics.js. A rodada
-- fica mais longa e as consultas se espalham por mais janelas de 5 minutos,
-- sem perder nada.
-- =====================================================

-- Antes de rodar, veja o que vai embora:
--
--   select count(*) filter (where uniques_30d is not null) as com_valor,
--          max(stats_30d_ate)                              as ate,
--          sum(uniques_30d)                                as unicos
--     from public.domains;

drop index if exists public.domains_uniques_30d_idx;

alter table public.domains
  drop column if exists uniques_30d,
  drop column if exists requests_30d,
  drop column if exists stats_30d_ate;
