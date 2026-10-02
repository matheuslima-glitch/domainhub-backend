-- =====================================================
-- REVERSA DE 2026-10-02-visitas-30d-por-dominio.sql
--
-- Remove a view. NÃO APAGA DADO NENHUM: ela é só uma soma sobre
-- `domain_daily_stats`, que continua intacta e continua sendo escrita pelo
-- coletor todo dia. Rodar isto e recriar a view depois devolve exatamente os
-- mesmos números.
--
-- ORDEM: reverta o CÓDIGO DO PAINEL primeiro. Com a view fora e a coluna
-- "Visitas/Mês" ainda tentando lê-la, a tela do Gerenciamento mostra o erro
-- de leitura em vez dos domínios.
-- =====================================================

drop view if exists public.domain_30d_totals;
