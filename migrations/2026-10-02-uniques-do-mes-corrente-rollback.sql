-- =====================================================
-- REVERSA DE 2026-10-02-uniques-do-mes-corrente.sql
--
-- APAGA DADO: os três valores do mês corrente de todos os domínios. Eles são
-- reconstruídos na próxima rodada do coletor (cron '20 5 * * *'), desde que o
-- código da terceira consulta ainda esteja lá — então na prática a perda é de
-- menos de um dia.
--
-- Nada mais depende destas colunas. `views_14d`, `uniques_14d`,
-- `last_view_date`, `monthly_uniques` e as tabelas de série não são tocadas.
--
-- ORDEM: reverta o CÓDIGO primeiro, nos dois repositórios. Com as colunas
-- fora e o coletor ainda tentando escrevê-las, o update falha e as CINCO
-- colunas de 14 dias deixam de ser gravadas junto — elas vão no mesmo
-- `update`. Isso derrubaria a aba Críticos e o CSV, que é bem pior do que o
-- problema que a reversa estaria tentando resolver.
-- =====================================================

-- Antes de rodar, veja o que vai embora:
--
--   select count(*) filter (where uniques_mes_corrente is not null) as com_valor,
--          max(mes_corrente_ref)                                    as mes,
--          sum(uniques_mes_corrente)                                as unicos
--     from public.domains;

drop index if exists public.domains_uniques_mes_corrente_idx;

alter table public.domains
  drop column if exists uniques_mes_corrente,
  drop column if exists requests_mes_corrente,
  drop column if exists mes_corrente_ref;
