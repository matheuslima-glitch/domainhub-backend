-- =====================================================
-- EDIÇÃO DE LOGS DE ATIVIDADE, COM RASTRO
--
-- Cole no SQL Editor do Supabase e rode.
--
-- POR QUE ISTO EXISTE
--
-- Hoje qualquer usuário do painel já consegue editar qualquer log de qualquer
-- domínio, e não há como saber que editou, porque rastro nenhum é gravado.
-- Duas políticas permitem isso:
--
--   "Users can update accessible domain logs"  UPDATE  using (domínio acessível)
--   "System can insert domain logs"            INSERT  with check (true)
--
-- Como TODOS os domínios pertencem à mesma conta (domains.user_id é o mesmo
-- valor nas 2.708 linhas), a condição da primeira é verdadeira para qualquer
-- pessoa que enxergue os domínios. A segunda não tem condição alguma: dá para
-- inserir um log em qualquer domínio, com o user_id que se quiser.
--
-- Esta migration FECHA as duas e abre no lugar um caminho único, restrito a
-- administradores e sempre registrado.
--
-- O QUE ELA NÃO FAZ
--
-- Não altera a estrutura de `domain_activity_logs` — nenhuma coluna entra,
-- sai ou muda de tipo. Não toca em nenhuma linha existente. Não mexe nas
-- políticas de SELECT nem na de INSERT do time, que continuam como estão.
--
-- A "System can insert domain logs" é removida sem perda: a service role do
-- backend passa por cima de RLS de qualquer forma, e os inserts legítimos do
-- painel já são cobertos por "Users can insert team domain logs".
-- =====================================================


-- -----------------------------------------------------
-- 1. Antes: registre o que está valendo
--
--    GUARDE ESTA SAÍDA. O arquivo de reversão precisa da coluna `roles`
--    para recriar as políticas exatamente como estavam.
-- -----------------------------------------------------

select policyname, roles, cmd, qual, with_check
  from pg_policies
 where tablename = 'domain_activity_logs'
 order by cmd, policyname;


-- -----------------------------------------------------
-- 2. Fecha a edição anônima
-- -----------------------------------------------------

drop policy if exists "Users can update accessible domain logs" on domain_activity_logs;
drop policy if exists "System can insert domain logs" on domain_activity_logs;

-- Sem política de UPDATE, o RLS nega por padrão. A partir daqui a tabela só
-- é alterada pela função do passo 4, que roda como dona e registra tudo.


-- -----------------------------------------------------
-- 3. O rastro. Só de acréscimo, por construção:
--    não recebe política de INSERT, UPDATE nem DELETE, então nem o painel
--    nem um usuário autenticado conseguem escrever ou apagar aqui.
--    Quem grava é a função do passo 4.
-- -----------------------------------------------------

create table if not exists domain_activity_log_edits (
  id            uuid primary key default gen_random_uuid(),
  log_id        uuid not null references domain_activity_logs(id) on delete cascade,
  edited_by     uuid,
  edited_at     timestamptz not null default now(),
  campo         text not null,
  valor_antigo  text,
  valor_novo    text
);

create index if not exists idx_log_edits_log_id on domain_activity_log_edits (log_id);

comment on table domain_activity_log_edits is
  'Rastro de edições em domain_activity_logs. Uma linha por campo alterado. Só editar_log_atividade() escreve aqui.';

alter table domain_activity_log_edits enable row level security;

-- Leitura segue a mesma regra dos logs: quem vê o log vê o rastro dele.
drop policy if exists "Ver rastro dos logs acessiveis" on domain_activity_log_edits;
create policy "Ver rastro dos logs acessiveis"
  on domain_activity_log_edits for select
  using (
    exists (
      select 1
        from domain_activity_logs l
        join domains d on d.id = l.domain_id
       where l.id = domain_activity_log_edits.log_id
         and d.user_id = get_data_owner_id()
    )
  );


-- -----------------------------------------------------
-- 4. O único caminho de edição
--
--    security definer: roda como dona da função, então enxerga por cima do
--    RLS que acabamos de fechar. A autorização é feita aqui dentro, no banco,
--    e não na interface — esconder o botão no painel é só conforto visual.
--
--    Tudo numa transação: ou o rastro e a alteração acontecem juntos, ou
--    nenhum dos dois. Não existe edição sem registro.
--
--    created_at, action_type e domain_id NÃO são parâmetros. A data do evento
--    e o tipo da ação são intocáveis, inclusive por administrador.
--
--    Os cinco parâmetros são obrigatórios: o painel manda sempre o valor atual
--    dos campos que não está mudando. Assim `is distinct from` detecta a
--    mudança de verdade, e passar NULL em user_id significa "sem autor" — o
--    par natural de user_name = 'Sistema' — e não "não mexer".
-- -----------------------------------------------------

create or replace function editar_log_atividade(
  p_log_id     uuid,
  p_user_id    uuid,
  p_user_name  text,
  p_old_value  text,
  p_new_value  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log    domain_activity_logs%rowtype;
  v_admin  boolean;
  v_quem   uuid := auth.uid();
begin
  if v_quem is null then
    raise exception 'Não autenticado';
  end if;

  select coalesce(is_admin, false) into v_admin from profiles where id = v_quem;
  if not coalesce(v_admin, false) then
    raise exception 'Apenas administradores podem editar logs de atividade';
  end if;

  select * into v_log from domain_activity_logs where id = p_log_id;
  if not found then
    raise exception 'Log % não encontrado', p_log_id;
  end if;

  -- Mesmo admin só mexe no que enxerga.
  if not exists (
    select 1 from domains d
     where d.id = v_log.domain_id
       and d.user_id = get_data_owner_id()
  ) then
    raise exception 'Sem acesso ao domínio deste log';
  end if;

  -- Uma linha de rastro por campo que muda de fato.
  if p_user_id is distinct from v_log.user_id then
    insert into domain_activity_log_edits (log_id, edited_by, campo, valor_antigo, valor_novo)
    values (p_log_id, v_quem, 'user_id', v_log.user_id::text, p_user_id::text);
  end if;

  if p_user_name is distinct from v_log.user_name then
    insert into domain_activity_log_edits (log_id, edited_by, campo, valor_antigo, valor_novo)
    values (p_log_id, v_quem, 'user_name', v_log.user_name, p_user_name);
  end if;

  if p_old_value is distinct from v_log.old_value then
    insert into domain_activity_log_edits (log_id, edited_by, campo, valor_antigo, valor_novo)
    values (p_log_id, v_quem, 'old_value', v_log.old_value, p_old_value);
  end if;

  if p_new_value is distinct from v_log.new_value then
    insert into domain_activity_log_edits (log_id, edited_by, campo, valor_antigo, valor_novo)
    values (p_log_id, v_quem, 'new_value', v_log.new_value, p_new_value);
  end if;

  update domain_activity_logs
     set user_id   = p_user_id,
         user_name = p_user_name,
         old_value = p_old_value,
         new_value = p_new_value
   where id = p_log_id;
end;
$$;

revoke all on function editar_log_atividade(uuid, uuid, text, text, text) from public;
grant execute on function editar_log_atividade(uuid, uuid, text, text, text) to authenticated;


-- -----------------------------------------------------
-- 5. Depois: confira
-- -----------------------------------------------------

-- Não deve sobrar nenhuma política de UPDATE nem a de INSERT sem condição:
select policyname, roles, cmd
  from pg_policies
 where tablename = 'domain_activity_logs'
 order by cmd, policyname;

-- O rastro nasce vazio:
select count(*) as rastros from domain_activity_log_edits;

-- A função existe e é security definer (prosecdef deve ser true):
select proname, prosecdef
  from pg_proc
 where proname = 'editar_log_atividade';
