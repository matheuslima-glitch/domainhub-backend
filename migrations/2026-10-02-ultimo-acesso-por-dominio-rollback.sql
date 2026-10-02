-- =====================================================
-- REVERSA DE 2026-10-02-ultimo-acesso-por-dominio.sql
--
-- Remove a view. NÃO APAGA DADO NENHUM: ela é só uma leitura sobre
-- `domain_daily_stats` e `domain_monthly_stats`, que continuam intactas e
-- continuam sendo escritas pelos crons. Recriar a view depois devolve
-- exatamente os mesmos números.
--
-- ORDEM: reverta o CÓDIGO DO PAINEL primeiro. Com a view fora e a aba "Sem
-- acesso" ainda tentando lê-la, a aba mostra erro de leitura em vez da lista.
-- =====================================================

drop view if exists public.domain_ultimo_acesso;
