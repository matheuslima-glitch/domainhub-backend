-- =====================================================
-- ROLLBACK — CONTA DO REGISTRADOR
--
-- Desfaz `2026-10-21-conta-do-registrador.sql`.
--
-- ── O QUE SE PERDE, E ISSO IMPORTA AQUI ──────────────────────────────────
--
-- Diferente do rollback dos preços, este APAGA informação que não dá para
-- recuperar sozinha: qual conta comprou cada domínio.
--
-- Se já houver compras distribuídas, derrubar a coluna significa que o
-- sistema deixa de saber que os domínios do Paulo são do Paulo. Eles
-- continuam existindo e funcionando na conta dele, mas daqui o sistema
-- passa a tratá-los como se fossem da principal — e aí a sincronia não os
-- alcança e a troca de nameserver falha, sem explicação visível.
--
-- ── ENTÃO, ANTES DE RODAR ISTO ───────────────────────────────────────────
--
-- 1. GUARDE a distribuição atual, se houver alguma:
--
--      select domain_name, registrar_account
--        from public.domains
--       where registrar_account is not null
--       order by registrar_account, domain_name;
--
--    Salve o resultado fora do banco. É a única cópia.
--
-- 2. Reverta o PR que liga o rodízio na compra, para novas compras não
--    voltarem a gravar numa coluna que não existe mais.
--
-- Se a consulta do passo 1 vier VAZIA, não há nada a perder: a coluna
-- nunca foi preenchida e este rollback é inofensivo.
-- =====================================================

drop index if exists public.domains_registrar_account_idx;

alter table public.domains
  drop column if exists registrar_account;
