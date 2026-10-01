-- =====================================================
-- SUPER ADMIN PASSA A PODER APROVAR O PRÓPRIO PEDIDO
--
-- Decidido com o time em 01/10/2026.
--
-- O QUE MUDA
--
-- `decidir_exclusao_lote` recusava quando o solicitante era quem decidia:
--
--     if v_lote.solicitante_id = auth.uid() then
--       raise exception 'Quem pediu a exclusão não pode aprová-la';
--     end if;
--
-- Essa verificação sai. Todo o resto da função continua igual — ainda só
-- super admin decide, ainda só pedido pendente, ainda só dentro das 24h.
--
-- POR QUE ISSO NÃO DESLIGA A TRAVA
--
-- A trava existe para que uma exclusão em massa não aconteça sem alguém com
-- poder de veto olhar. Para quem NÃO é super admin — que é a maior parte da
-- equipe — nada muda: continua precisando que um super admin aprove.
--
-- O que muda é só para quem já tinha o poder de aprovar de qualquer forma.
-- Um super admin que queira excluir em lote hoje precisa chamar outro super
-- admin; na prática isso fazia dois super admins se aprovarem em par, o que
-- não acrescenta controle nenhum e trava a operação quando só há um
-- disponível.
--
-- O QUE SE PERDE, DITO CLARAMENTE
--
-- A separação entre quem pede e quem aprova deixa de valer no topo. Um super
-- admin sozinho passa a conseguir excluir em massa sem nenhum outro par de
-- olhos. O registro continua: `exclusao_lote` guarda quem pediu e quem
-- decidiu, e nesses casos serão a mesma pessoa — o que fica visível no
-- histórico, e é por isso que o campo `decidido_por` não foi mexido.
--
-- COMO VOLTAR ATRÁS
--
-- `2026-10-01-super-admin-aprova-o-proprio-rollback.sql` recria a função com
-- a verificação de volta.
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

  -- A verificação de "quem pediu não aprova" saiu aqui em 01/10/2026.
  -- Ver o cabeçalho deste arquivo.

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
  'Aprova ou recusa um pedido de exclusão em lote. Só super admin, qualquer um deles, INCLUSIVE quem pediu (mudado em 01/10/2026). Pedido precisa estar pendente e dentro do prazo.';
