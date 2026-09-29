-- =====================================================
-- REVERSÃO — desfaz 2026-09-29-aprovacao-de-exclusao.sql
--
-- Cole no SQL Editor do Supabase e rode.
--
-- ANTES DE RODAR ISTO, PENSE DUAS VEZES
--
-- Na maioria dos casos você NÃO quer reverter. Quer DESLIGAR. São coisas
-- diferentes:
--
--   DESLIGAR  → EXCLUSAO_EXIGE_APROVACAO=false no Render, e restart.
--               Leva um minuto, não perde nada, e dá para religar depois.
--
--   REVERTER  → apaga as tabelas e o histórico de quem excluiu o quê.
--               Só faz sentido se a funcionalidade inteira for abandonada.
--
-- Se o problema é "a trava está atrapalhando agora", use a variável.
--
-- ORDEM IMPORTA
--
-- Reverta ANTES a parte do backend e a do painel. Se o backend continuar
-- chamando pode_excluir_dominio() depois que ela sumir, toda exclusão passa
-- a dar erro — o oposto do que você queria ao reverter.
--
-- O QUE SE PERDE
--
-- O registro de quem excluiu qual domínio e quando, e o histórico de pedidos
-- e decisões. O passo 1 exporta as três tabelas; depois do passo 3 não
-- existem mais.
--
-- O QUE NÃO SE PERDE
--
-- Nada de `domains`, `domain_activity_logs`, `profiles` ou `super_admins`.
-- Nenhum domínio é afetado, nenhum volta nem deixa de voltar. O cargo de
-- super admin continua de pé — ele é de outra migration.
-- =====================================================


-- -----------------------------------------------------
-- 1. PRIMEIRO: exporte as três tabelas
--    Guarde estas saídas. Depois do passo 3 elas não existem mais.
-- -----------------------------------------------------

select * from public.exclusao_lote order by criado_em;

select i.*, l.status, l.solicitante_nome
  from public.exclusao_lote_item i
  join public.exclusao_lote l on l.id = i.lote_id
 order by l.criado_em, i.domain_name;

select * from public.exclusao_execucao order by em;


-- -----------------------------------------------------
-- 2. As funções
--
--    Fora antes das tabelas: elas leem as tabelas, e derrubar na ordem
--    contrária deixaria funções apontando para o que não existe mais.
-- -----------------------------------------------------

drop function if exists public.decidir_exclusao_lote(uuid, boolean, text);
drop function if exists public.solicitar_exclusao_lote(uuid, jsonb, text, text);
drop function if exists public.registrar_exclusao(uuid, text, uuid);
drop function if exists public.pode_excluir_dominio(uuid, uuid);
drop function if exists public.exclusao_janela_ritmo();


-- -----------------------------------------------------
-- 3. As tabelas
--
--    `exclusao_lote_item` tem cascade a partir de `exclusao_lote`, e
--    `exclusao_execucao` referencia o lote — por isso o item sai primeiro e
--    a execução antes do lote. As políticas caem junto com as tabelas.
-- -----------------------------------------------------

drop table if exists public.exclusao_lote_item;
drop table if exists public.exclusao_execucao;
drop table if exists public.exclusao_lote;


-- -----------------------------------------------------
-- 4. Confere
--
--    As duas consultas têm que voltar VAZIAS.
-- -----------------------------------------------------

select tablename
  from pg_tables
 where schemaname = 'public'
   and tablename in ('exclusao_lote', 'exclusao_lote_item', 'exclusao_execucao');

select proname
  from pg_proc
 where proname in ('exclusao_janela_ritmo', 'pode_excluir_dominio', 'registrar_exclusao',
                   'solicitar_exclusao_lote', 'decidir_exclusao_lote');


-- -----------------------------------------------------
-- 5. E confere que o cargo de super admin continua intacto
--
--    Tem que voltar o Lerricke. Esta reversão não deveria tocar nele.
-- -----------------------------------------------------

select nome, email, originario from public.super_admins;
