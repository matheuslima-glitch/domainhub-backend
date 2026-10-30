-- =====================================================
-- REVERSA DE 2026-10-30-presenca-cloudflare-whm.sql
--
-- APAGA DADO: a última conferência de presença de todos os domínios. Não há
-- histórico a perder — a próxima rodada reconstrói tudo, desde que o código
-- ainda esteja lá.
--
-- ORDEM: reverta o CÓDIGO primeiro, nos dois repositórios.
--
--   backend  com as colunas fora, a conferência das 05:00 falha no `update`
--            e registra erro no log. Não derruba nenhuma outra coleta — ela
--            roda sozinha, em comando próprio.
--
--   painel   a aba "Sem acesso" lê estas colunas; sem elas a aba mostra
--            erro no lugar da lista. As outras abas não as leem.
-- =====================================================

-- Antes de rodar, veja o que vai embora:
--
--   select count(*) filter (where na_cloudflare and no_whm) as nos_dois,
--          count(*) filter (where na_cloudflare is null)    as nao_conferidos,
--          max(presenca_conferida_em)                       as ultima
--     from public.domains;

alter table public.domains
  drop column if exists na_cloudflare,
  drop column if exists no_whm,
  drop column if exists presenca_conferida_em;
