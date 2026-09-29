-- =====================================================
-- REVERSÃO — desfaz 2026-09-28-cargo-super-admin.sql
--
-- Cole no SQL Editor do Supabase e rode. Volta o banco exatamente ao estado
-- anterior: o cargo deixa de existir, e sobram os dois níveis de sempre
-- (profiles.is_admin e user_permissions).
--
-- QUANDO USAR ESTA REVERSÃO SOZINHA
--
-- Só enquanto NADA estiver usando o cargo. Se a migration de aprovação de
-- exclusão em lote já tiver sido aplicada, reverta AQUELA primeiro: ela chama
-- e_super_admin(), e derrubar a função aqui quebraria a aprovação, deixando os
-- lotes pendentes sem ninguém que possa decidir.
--
-- Para conferir se alguém depende:
--
--   select p.proname
--     from pg_proc p
--    where p.prosrc ilike '%e_super_admin%'
--      and p.proname <> 'e_super_admin';
--
-- Se essa consulta voltar qualquer linha, PARE e reverta a outra migration
-- antes.
--
-- O QUE SE PERDE: o registro de quem estava no cargo e desde quando. O passo 1
-- exporta isso. Depois do passo 3 não existe mais.
--
-- O QUE NÃO SE PERDE: nada de `profiles`, nada de `user_permissions`, nenhuma
-- conta de usuário. A migration original nunca escreveu nessas tabelas, então
-- não há o que desfazer nelas. Ninguém perde nem ganha acesso ao painel: quem
-- era admin continua admin.
-- =====================================================


-- -----------------------------------------------------
-- 1. PRIMEIRO: salve quem estava no cargo
--    Exporte esta saída antes de seguir. Depois do passo 3 ela não existe mais,
--    e é o que você vai precisar para semear de novo se mudar de ideia.
-- -----------------------------------------------------

select user_id, nome, email, originario, criado_em, criado_por
  from public.super_admins
 order by originario desc, criado_em;


-- -----------------------------------------------------
-- 2. As funções
--
--    Fora antes da tabela: definir_super_admin() chama e_super_admin(), que lê
--    super_admins. Derrubar na ordem contrária deixaria funções apontando para
--    uma tabela que já não existe.
-- -----------------------------------------------------

drop function if exists public.definir_super_admin(uuid, boolean);
drop function if exists public.e_super_admin_originario(uuid);
drop function if exists public.e_super_admin(uuid);


-- -----------------------------------------------------
-- 3. A tabela
--
--    A política de SELECT cai junto com ela; não precisa de drop policy.
-- -----------------------------------------------------

drop table if exists public.super_admins;


-- -----------------------------------------------------
-- 4. Confere
--
--    As três consultas têm que voltar VAZIAS.
-- -----------------------------------------------------

select tablename
  from pg_tables
 where schemaname = 'public'
   and tablename = 'super_admins';

select proname
  from pg_proc
 where proname in ('e_super_admin', 'e_super_admin_originario', 'definir_super_admin');

select policyname
  from pg_policies
 where tablename = 'super_admins';


-- -----------------------------------------------------
-- 5. E confere que ninguém foi afetado de tabela
--
--    A contagem de admins tem que bater com a que você guardou no passo 1 da
--    migration original.
-- -----------------------------------------------------

select count(*) as admins
  from public.profiles
 where is_admin = true;
