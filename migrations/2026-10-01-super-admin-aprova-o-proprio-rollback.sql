-- =====================================================
-- REVERSA DE 2026-10-01-super-admin-aprova-o-proprio.sql
--
-- Devolve a regra "quem pediu não aprova": um super admin volta a precisar
-- de OUTRO super admin para aprovar o próprio pedido de exclusão.
--
-- É só recriar a função com a verificação de volta. Nada de dado muda, e
-- nenhum pedido já decidido é afetado — pedidos aprovados pelo próprio
-- solicitante entre a ida e a volta continuam aprovados, com o histórico
-- mostrando a mesma pessoa em `solicitante_id` e `decidido_por`.
--
-- Rodar isto NÃO desfaz as aprovações feitas no período. Se for preciso
-- revisar alguma, a consulta está no fim deste arquivo.
-- =====================================================

create or replace function public.decidir_exclusao_lote(
  p_lote_id    uuid,
  p_aprovar    boolean,
  p_observacao text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lote record;
  v_nome text;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado';
  end if;

  if not public.e_super_admin(auth.uid()) then
    raise exception 'Só um super admin pode decidir um pedido de exclusão';
  end if;

  select * into v_lote from public.exclusao_lote where id = p_lote_id;
  if not found then
    raise exception 'Pedido % não existe', p_lote_id;
  end if;

  if v_lote.solicitante_id = auth.uid() then
    raise exception 'Quem pediu a exclusão não pode aprová-la';
  end if;

  if v_lote.status <> 'pendente' then
    raise exception 'Este pedido já foi %', v_lote.status;
  end if;

  if v_lote.expira_em <= now() then
    raise exception 'Este pedido venceu em % e precisa ser refeito', v_lote.expira_em;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_nome
    from public.profiles where id = auth.uid();

  update public.exclusao_lote
     set status            = case when p_aprovar then 'aprovado' else 'recusado' end,
         decidido_por      = auth.uid(),
         decidido_por_nome = coalesce(v_nome, 'Usuário sem nome'),
         decidido_em       = now(),
         observacao        = nullif(trim(p_observacao), '')
   where id = p_lote_id;
end;
$$;

comment on function public.decidir_exclusao_lote(uuid, boolean, text) is
  'Aprova ou recusa um pedido de exclusão em lote. Só super admin, qualquer um deles, e NUNCA quem pediu.';

-- Quais pedidos foram aprovados pelo próprio solicitante enquanto a regra
-- esteve desligada:
--
--   select id, solicitante_nome, decidido_em, status
--     from public.exclusao_lote
--    where solicitante_id = decidido_por
--    order by decidido_em desc;
