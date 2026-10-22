-- =====================================================
-- ROLLBACK — HISTÓRICO DE RENOVAÇÃO
--
-- Desfaz `2026-10-22-historico-de-renovacao.sql`.
--
-- ── O QUE SE PERDE, E AQUI É DINHEIRO ────────────────────────────────────
--
-- Esta tabela é a ÚNICA fonte do que foi realmente cobrado em cada
-- renovação. `tld_pricing` tem preço de tabela, que não é a mesma coisa:
-- promoção, cupom e preço premium fazem o cobrado divergir.
--
-- Apagando, a resposta para "quanto este domínio já consumiu" deixa de
-- existir no sistema. Ela não se reconstrói sozinha — a Namecheap não
-- devolve histórico por domínio pela API.
--
-- E some também a trava contra cobrança duplicada: sem a tabela, o backend
-- não tem como saber que um domínio já foi renovado há cinco minutos.
--
-- ── ANTES DE RODAR ISTO ──────────────────────────────────────────────────
--
-- 1. EXPORTE o conteúdo. É a única cópia:
--
--      select domain_name, renovado_em, anos, cobrado_usd, conta,
--             order_id, transaction_id, expiracao_anterior, expiracao_nova
--        from public.domain_renewals
--       order by renovado_em;
--
--    Guarde fora do banco. Os `order_id` permitem reconciliar com a fatura
--    da Namecheap depois, se precisar.
--
-- 2. Reverta o PR da tela de renovação, para o backend não tentar gravar
--    numa tabela que não existe mais. Sem isso, toda renovação falha
--    DEPOIS de a Namecheap já ter cobrado — dinheiro gasto sem registro.
--
-- A ordem importa: código primeiro, tabela depois.
--
-- Se a consulta do passo 1 vier VAZIA, nenhuma renovação foi feita por aqui
-- e este rollback é inofensivo.
-- =====================================================

drop policy if exists "Users can view accessible renewals" on public.domain_renewals;
drop policy if exists "Service role full access renewals" on public.domain_renewals;

drop index if exists public.domain_renewals_domain_idx;
drop index if exists public.domain_renewals_data_idx;

drop table if exists public.domain_renewals;
