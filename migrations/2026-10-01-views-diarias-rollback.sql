-- =====================================================
-- REVERSA DE 2026-10-01-views-diarias.sql
--
-- Remove a view e a tabela da série diária.
--
-- APAGA DADO. Tudo o que o coletor tiver gravado em `domain_daily_stats` se
-- perde, e a Cloudflare só retém cerca de um ano — o que estiver fora dessa
-- janela não volta nem por backfill.
--
-- Nada mais depende destas duas coisas: `domains`, `domain_monthly_stats` e
-- `monthly_uniques_totals` não são tocadas. O coletor diário volta a fazer o
-- que fazia antes (calcular `views_14d` e descartar a quebra por dia) assim
-- que o código correspondente for revertido.
--
-- ORDEM: reverta o CÓDIGO primeiro. Com a tabela fora e o coletor ainda
-- tentando gravar, cada rodada falha no upsert — não derruba o resto, mas
-- enche o log de erro.
-- =====================================================

-- Antes de rodar, veja o que vai embora:
--
--   select count(*) as linhas,
--          min(data) as mais_antiga,
--          max(data) as mais_recente,
--          count(distinct domain_id) as dominios
--     from public.domain_daily_stats;

drop view if exists public.daily_totals;

drop index if exists public.domain_daily_stats_com_acesso_idx;
drop index if exists public.domain_daily_stats_data_idx;

drop table if exists public.domain_daily_stats;
