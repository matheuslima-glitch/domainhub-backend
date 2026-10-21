-- =====================================================
-- ROLLBACK — PREÇO DE RENOVAÇÃO POR TERMINAÇÃO
--
-- Desfaz `2026-10-21-precos-de-renovacao.sql`.
--
-- ── O QUE SE PERDE ───────────────────────────────────────────────────────
--
-- Os preços coletados. Não é perda real: eles são uma CÓPIA do catálogo da
-- Namecheap, e a coleta seguinte traz tudo de volta em uma chamada. Nenhum
-- dado de domínio, tráfego ou compra mora aqui.
--
-- ── O QUE PRECISA ACONTECER ANTES ────────────────────────────────────────
--
-- 1. Reverter o PR do painel que fez `renovacaoDe()` ler esta tabela.
--    Sem isso a aba Custo fica com TODAS as terminações em "sem preço na
--    tabela" e o custo de manter cai para só a hospedagem. Não quebra a
--    tela — o caminho de preço ausente já existia e é tratado —, mas o
--    número fica errado por omissão, que é pior do que fora do ar.
--
-- 2. Tirar o cron de `src/server.js` (ou só deixar: ele vai falhar no
--    upsert, gritar no log e não derrubar nada; o `catch` do agendador
--    isola).
--
-- A ordem importa: painel primeiro, tabela depois.
-- =====================================================

drop policy if exists "Authenticated can read tld pricing" on public.tld_pricing;
drop policy if exists "Service role full access tld pricing" on public.tld_pricing;

-- Sem `cascade`: nada depende desta tabela. Se o `drop` reclamar de
-- dependência, é porque alguém criou uma view ou chave estrangeira em cima
-- dela depois — e aí vale olhar o que é antes de derrubar junto.
drop table if exists public.tld_pricing;
