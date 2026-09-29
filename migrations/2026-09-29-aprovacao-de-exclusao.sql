-- =====================================================
-- APROVAÇÃO PARA EXCLUSÃO DE DOMÍNIOS
--
-- Cole no SQL Editor do Supabase e rode.
--
-- DEPENDE de 2026-09-28-cargo-super-admin.sql, que precisa já estar aplicada:
-- as funções daqui chamam e_super_admin().
--
-- O QUE ELA CRIA
--
-- Duas regras que exigem aprovação de um super admin antes de o domínio sair
-- do ar:
--
--   1. LOTE   — dois ou mais domínios excluídos juntos;
--   2. RITMO  — a terceira exclusão avulsa da mesma pessoa em 20 minutos.
--
-- A segunda existe porque a primeira sozinha não trava nada: bastaria clicar
-- um domínio por vez para passar por baixo.
--
-- POR QUE UMA TABELA PRÓPRIA DE EXECUÇÕES
--
-- A regra de ritmo precisa contar exclusões recentes. O caminho óbvio seria
-- contar em `domain_activity_logs` — mas a migration de 24/09 tornou aquela
-- tabela EDITÁVEL por admin. Um admin poderia corrigir o próprio histórico
-- para escapar da trava. `exclusao_execucao` não tem caminho de escrita nem
-- de edição pelo cliente: só a função abaixo escreve, e nada apaga.
--
-- ONDE A TRAVA REALMENTE MORA
--
-- No backend, que chama `pode_excluir_dominio()` antes de cada passo
-- destrutivo. Fazer só no painel não travaria nada: quem chamasse a API
-- direto passaria por cima. Esta migration entrega as regras; o backend é
-- quem as consulta.
--
-- COMO DESLIGAR SEM DEPLOY
--
-- A variável EXCLUSAO_EXIGE_APROVACAO=false no Render faz o backend ignorar
-- a trava. Um restart, sem git, sem build. É a saída se isto travar o
-- trabalho de alguém numa sexta à noite.
--
-- O QUE ELA NÃO FAZ
--
-- Não altera `domains`, `domain_activity_logs`, `profiles` nem
-- `super_admins`. Nenhuma coluna entra, sai ou muda. Nenhuma política
-- existente é tocada. Enquanto o backend não for atualizado, estas tabelas
-- ficam vazias e nada muda de comportamento.
-- =====================================================


-- -----------------------------------------------------
-- 1. ANTES: confirme que o cargo existe
--
--    Tem que voltar uma linha. Se vier vazio, pare: rode antes a migration
--    do super admin, senão as funções daqui nascem quebradas.
-- -----------------------------------------------------

select nome, email, originario from public.super_admins;


-- -----------------------------------------------------
-- 2. O pedido
--
--    `origem` distingue quem nasceu de um lote de quem nasceu da regra de
--    ritmo — na hora de entender um bloqueio, isso é a primeira pergunta.
--
--    `expira_em` não precisa de rotina de limpeza: as consultas tratam
--    pedido vencido como não aprovado. Um cron só para virar um status seria
--    peça a mais para quebrar.
-- -----------------------------------------------------

create table if not exists public.exclusao_lote (
  id                 uuid primary key default gen_random_uuid(),
  solicitante_id     uuid not null references auth.users(id),
  solicitante_nome   text not null,
  motivo             text,
  origem             text not null default 'lote' check (origem in ('lote', 'ritmo')),
  status             text not null default 'pendente'
                     check (status in ('pendente', 'aprovado', 'recusado')),
  criado_em          timestamptz not null default now(),
  expira_em          timestamptz not null default now() + interval '24 hours',
  decidido_por       uuid references auth.users(id),
  decidido_por_nome  text,
  decidido_em        timestamptz,
  observacao         text
);

create index if not exists exclusao_lote_pendentes
  on public.exclusao_lote (criado_em desc) where status = 'pendente';


-- -----------------------------------------------------
-- 3. Os domínios de cada pedido
--
--    `executado_em` marca o que já saiu. Um pedido aprovado vale UMA vez por
--    domínio: sem isso, uma aprovação viraria passe livre permanente para
--    aquele domínio.
-- -----------------------------------------------------

create table if not exists public.exclusao_lote_item (
  lote_id       uuid not null references public.exclusao_lote(id) on delete cascade,
  domain_id     uuid not null,
  domain_name   text not null,
  executado_em  timestamptz,
  primary key (lote_id, domain_id)
);

-- Busca quente da trava: "este domínio está em algum pedido em aberto?"
create index if not exists exclusao_item_por_dominio
  on public.exclusao_lote_item (domain_id) where executado_em is null;


-- -----------------------------------------------------
-- 4. O que de fato foi excluído
--
--    Append-only. Só `registrar_exclusao()` escreve, e nada aqui apaga nem
--    atualiza. É a base da regra de ritmo, e a razão de não usarmos
--    domain_activity_logs para isso.
-- -----------------------------------------------------

create table if not exists public.exclusao_execucao (
  id           bigserial primary key,
  domain_id    uuid not null,
  domain_name  text not null,
  user_id      uuid not null,
  lote_id      uuid references public.exclusao_lote(id),
  em           timestamptz not null default now()
);

create index if not exists exclusao_execucao_por_usuario
  on public.exclusao_execucao (user_id, em desc);


-- -----------------------------------------------------
-- 5. RLS: leitura para quem está logado, escrita para ninguém
--
--    A leitura precisa existir para o painel listar pedidos pendentes e
--    mostrar o motivo de um bloqueio. A escrita não tem política em nenhuma
--    das três: o único caminho são as funções abaixo.
-- -----------------------------------------------------

alter table public.exclusao_lote        enable row level security;
alter table public.exclusao_lote_item   enable row level security;
alter table public.exclusao_execucao    enable row level security;

drop policy if exists "Autenticados leem pedidos" on public.exclusao_lote;
create policy "Autenticados leem pedidos" on public.exclusao_lote
  for select to authenticated using (true);

drop policy if exists "Autenticados leem itens" on public.exclusao_lote_item;
create policy "Autenticados leem itens" on public.exclusao_lote_item
  for select to authenticated using (true);

drop policy if exists "Autenticados leem execucoes" on public.exclusao_execucao;
create policy "Autenticados leem execucoes" on public.exclusao_execucao
  for select to authenticated using (true);


-- -----------------------------------------------------
-- 6. A janela da regra de ritmo
--
--    Vinte minutos, definido com o time em 29/09/2026. Fica numa função
--    própria para mudar em um lugar só, sem mexer na lógica.
--
--    A terceira exclusão é que trava: a função bloqueia quando JÁ existem
--    duas na janela.
-- -----------------------------------------------------

create or replace function public.exclusao_janela_ritmo()
returns interval
language sql
immutable
as $$ select interval '20 minutes' $$;


-- -----------------------------------------------------
-- 7. A pergunta que o backend faz antes de destruir qualquer coisa
--
--    Recebe o usuário como PARÂMETRO, e não por auth.uid(): quem chama é o
--    backend com a service role, onde auth.uid() é nulo. Quem garante que o
--    id é verdadeiro é o middleware que valida o JWT antes.
--
--    Devolve jsonb para o backend poder repassar o motivo ao painel sem
--    precisar traduzir código de erro.
-- -----------------------------------------------------

create or replace function public.pode_excluir_dominio(p_domain_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lote   record;
  v_recentes int;
begin
  -- 1. Pedido aprovado e ainda não usado para este domínio: passa.
  select l.id into v_lote
    from public.exclusao_lote_item i
    join public.exclusao_lote l on l.id = i.lote_id
   where i.domain_id = p_domain_id
     and i.executado_em is null
     and l.status = 'aprovado'
     and l.expira_em > now()
   limit 1;

  if found then
    return jsonb_build_object('permitido', true, 'motivo', 'lote_aprovado', 'lote_id', v_lote.id);
  end if;

  -- 2. Pedido ainda em aberto: barra, e diz qual.
  select l.id into v_lote
    from public.exclusao_lote_item i
    join public.exclusao_lote l on l.id = i.lote_id
   where i.domain_id = p_domain_id
     and i.executado_em is null
     and l.status = 'pendente'
     and l.expira_em > now()
   limit 1;

  if found then
    return jsonb_build_object(
      'permitido', false,
      'motivo', 'aguardando_aprovacao',
      'lote_id', v_lote.id,
      'mensagem', 'Este domínio está num pedido de exclusão aguardando aprovação de um super admin.');
  end if;

  -- 3. Avulso: conta o que esta pessoa já excluiu na janela.
  select count(*) into v_recentes
    from public.exclusao_execucao e
   where e.user_id = p_user_id
     and e.em > now() - public.exclusao_janela_ritmo();

  if v_recentes >= 2 then
    return jsonb_build_object(
      'permitido', false,
      'motivo', 'ritmo',
      'recentes', v_recentes,
      'mensagem', 'Você já excluiu ' || v_recentes || ' domínios nos últimos 20 minutos. ' ||
                  'A partir da terceira, a exclusão precisa da aprovação de um super admin.');
  end if;

  return jsonb_build_object('permitido', true, 'motivo', 'avulso');
end;
$$;


-- -----------------------------------------------------
-- 8. Registrar que um domínio saiu
--
--    Chamada pelo backend depois de a exclusão terminar. Marca o item do
--    pedido como executado (se veio de um) e grava a linha que alimenta a
--    regra de ritmo.
-- -----------------------------------------------------

create or replace function public.registrar_exclusao(
  p_domain_id   uuid,
  p_domain_name text,
  p_user_id     uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lote_id uuid;
begin
  update public.exclusao_lote_item
     set executado_em = now()
   where domain_id = p_domain_id
     and executado_em is null
     and lote_id in (select id from public.exclusao_lote
                      where status = 'aprovado' and expira_em > now())
  returning lote_id into v_lote_id;

  insert into public.exclusao_execucao (domain_id, domain_name, user_id, lote_id)
  values (p_domain_id, p_domain_name, p_user_id, v_lote_id);
end;
$$;


-- -----------------------------------------------------
-- 9. Abrir um pedido
--
--    Chamada pelo BACKEND, que passa o solicitante por parâmetro — mesmo
--    padrão de pode_excluir_dominio(). Não é liberada para `authenticated`:
--    se fosse, qualquer pessoa abriria pedido no nome de outra, e a regra
--    "quem pediu não aprova" viraria letra morta.
--
--    Quem garante que o id é verdadeiro é o middleware que valida o JWT
--    antes de a rota rodar.
--
--    Domínios em jsonb: [{"id": "...", "nome": "..."}, ...]
--
--    Domínio que já esteja num pedido em aberto não entra de novo — dois
--    pedidos para o mesmo domínio deixariam a trava ambígua.
-- -----------------------------------------------------

create or replace function public.solicitar_exclusao_lote(
  p_solicitante uuid,
  p_dominios    jsonb,
  p_motivo      text default null,
  p_origem      text default 'lote'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lote_id uuid;
  v_nome    text;
  v_quantos int;
begin
  if p_solicitante is null then
    raise exception 'Solicitante não informado';
  end if;

  if p_dominios is null or jsonb_array_length(p_dominios) = 0 then
    raise exception 'Nenhum domínio informado';
  end if;

  select coalesce(nullif(full_name, ''), email) into v_nome
    from public.profiles where id = p_solicitante;

  insert into public.exclusao_lote (solicitante_id, solicitante_nome, motivo, origem)
  values (p_solicitante, coalesce(v_nome, 'Usuário sem nome'), nullif(trim(p_motivo), ''),
          case when p_origem = 'ritmo' then 'ritmo' else 'lote' end)
  returning id into v_lote_id;

  insert into public.exclusao_lote_item (lote_id, domain_id, domain_name)
  select v_lote_id,
         (d->>'id')::uuid,
         coalesce(d->>'nome', d->>'id')
    from jsonb_array_elements(p_dominios) d
   where not exists (
     select 1 from public.exclusao_lote_item i
       join public.exclusao_lote l on l.id = i.lote_id
      where i.domain_id = (d->>'id')::uuid
        and i.executado_em is null
        and l.status in ('pendente', 'aprovado')
        and l.expira_em > now())
  on conflict do nothing;

  select count(*) into v_quantos from public.exclusao_lote_item where lote_id = v_lote_id;
  if v_quantos = 0 then
    delete from public.exclusao_lote where id = v_lote_id;
    raise exception 'Todos os domínios informados já estão em um pedido em aberto';
  end if;

  return v_lote_id;
end;
$$;


-- -----------------------------------------------------
-- 10. Decidir um pedido
--
--     Só super admin, qualquer um deles — decidido com o time em 29/09/2026.
--     O originário não tem privilégio aqui: aquilo vale só para distribuir o
--     cargo.
--
--     Quem pediu não decide, nem sendo super admin. É o ponto inteiro da
--     trava: ninguém aprova a própria exclusão.
-- -----------------------------------------------------

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


-- -----------------------------------------------------
-- 11. Permissões
--
--     `pode_excluir_dominio` e `registrar_exclusao` NÃO são liberadas para
--     `authenticated`: elas recebem o id do usuário por parâmetro, e liberar
--     para o cliente deixaria qualquer pessoa registrar exclusão no nome de
--     outra. Só o backend, com a service role, chama essas duas.
-- -----------------------------------------------------

revoke all on function public.pode_excluir_dominio(uuid, uuid) from public;
revoke all on function public.registrar_exclusao(uuid, text, uuid) from public;
revoke all on function public.solicitar_exclusao_lote(uuid, jsonb, text, text) from public;

-- Só esta é liberada para o cliente. Ela usa auth.uid() e confere o cargo,
-- então não dá para decidir no nome de outra pessoa.
revoke all on function public.decidir_exclusao_lote(uuid, boolean, text) from public;
grant execute on function public.decidir_exclusao_lote(uuid, boolean, text) to authenticated;


-- -----------------------------------------------------
-- 12. Confere
-- -----------------------------------------------------

-- As três tabelas existem e estão vazias.
select 'exclusao_lote' as tabela, count(*) from public.exclusao_lote
union all select 'exclusao_lote_item', count(*) from public.exclusao_lote_item
union all select 'exclusao_execucao', count(*) from public.exclusao_execucao;

-- As cinco funções existem, todas security definer.
select proname, prosecdef
  from pg_proc
 where proname in ('exclusao_janela_ritmo', 'pode_excluir_dominio', 'registrar_exclusao',
                   'solicitar_exclusao_lote', 'decidir_exclusao_lote')
 order by proname;

-- Só políticas de SELECT nas três. Qualquer INSERT, UPDATE ou DELETE aqui
-- significa que a trava tem um buraco — pare e me avise.
select tablename, policyname, cmd
  from pg_policies
 where tablename in ('exclusao_lote', 'exclusao_lote_item', 'exclusao_execucao')
 order by tablename;

-- E a trava respondendo: para um domínio qualquer e um usuário qualquer, sem
-- nenhuma exclusão registrada, tem que vir permitido = true, motivo = avulso.
select public.pode_excluir_dominio(
  (select id from public.domains limit 1),
  (select id from auth.users limit 1));
