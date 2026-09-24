-- =====================================================
-- REVERSÃO — desfaz 2026-09-24-editar-logs-de-atividade.sql
--
-- Cole no SQL Editor do Supabase e rode. Volta o banco ao estado anterior:
-- as duas políticas abertas de volta, a função e o rastro removidos.
--
-- ANTES DE RODAR, TIRE O BOTÃO DO AR. Se o painel novo continuar publicado
-- ele vai chamar uma função que não existe mais, e o admin recebe erro ao
-- tentar editar. Reverta o commit do painel primeiro (git revert), ou aceite
-- que o botão fica quebrado até fazer isso.
--
-- O QUE SE PERDE: o histórico de edições. Se alguma edição já foi feita,
-- rode o passo 1 ANTES de qualquer outra coisa e guarde a saída — é a única
-- cópia do que foi alterado, e o passo 4 apaga a tabela.
--
-- O QUE NÃO SE PERDE: nada em domain_activity_logs. A migration nunca alterou
-- a estrutura dessa tabela. As linhas que foram editadas continuam com o valor
-- editado — reverter a migration não desfaz as edições, só remove a
-- capacidade de editar. Para desfazer uma edição específica, use a saída do
-- passo 1: cada linha traz valor_antigo.
-- =====================================================


-- -----------------------------------------------------
-- 1. PRIMEIRO: salve o rastro, se houver
--    Exporte esta saída antes de seguir. Depois do passo 4 ela não existe mais.
-- -----------------------------------------------------

select e.edited_at,
       e.edited_by,
       p.full_name as editado_por,
       d.domain_name,
       l.action_type,
       e.campo,
       e.valor_antigo,
       e.valor_novo
  from domain_activity_log_edits e
  join domain_activity_logs l on l.id = e.log_id
  join domains d              on d.id = l.domain_id
  left join profiles p        on p.id = e.edited_by
 order by e.edited_at;


-- -----------------------------------------------------
-- 2. Remove o caminho de edição controlada
-- -----------------------------------------------------

drop function if exists editar_log_atividade(uuid, uuid, text, text, text);


-- -----------------------------------------------------
-- 3. Recria as duas políticas como estavam
--
--    CONFERIDO EM 24/09/2026. A saída de pg_policies mostrou que as duas
--    políticas removidas eram `{public}`:
--
--      "System can insert domain logs"            {public}  INSERT  with check (true)
--      "Users can update accessible domain logs"  {public}  UPDATE
--
--    `create policy` sem cláusula `to` já é `to public`, então o que está
--    abaixo recria as duas exatamente como estavam. Nada a ajustar.
-- -----------------------------------------------------

create policy "Users can update accessible domain logs"
  on domain_activity_logs for update
  using (
    exists (
      select 1 from domains d
       where d.id = domain_activity_logs.domain_id
         and d.user_id = get_data_owner_id()
    )
  );

create policy "System can insert domain logs"
  on domain_activity_logs for insert
  with check (true);


-- -----------------------------------------------------
-- 4. Remove o rastro
--    Irreversível. Confirme que salvou a saída do passo 1.
-- -----------------------------------------------------

drop table if exists domain_activity_log_edits;


-- -----------------------------------------------------
-- 5. Confira que voltou ao estado anterior
--    Devem aparecer 5 políticas: 2 SELECT, 2 INSERT, 1 UPDATE.
-- -----------------------------------------------------

select policyname, roles, cmd
  from pg_policies
 where tablename = 'domain_activity_logs'
 order by cmd, policyname;

-- Não deve retornar nada:
select proname from pg_proc where proname = 'editar_log_atividade';

select to_regclass('public.domain_activity_log_edits') as tabela_rastro;  -- deve ser null
