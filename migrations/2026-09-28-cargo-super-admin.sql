-- =====================================================
-- CARGO DE SUPER ADMIN
--
-- Cole no SQL Editor do Supabase e rode, passo a passo.
--
-- POR QUE ISTO EXISTE
--
-- O painel só conhece dois níveis: `profiles.is_admin = true`, que libera
-- tudo, e `user_permissions`, que dá permissões avulsas a quem não é admin.
-- Não existe ninguém acima dos admins. A aprovação de exclusão em lote precisa
-- de alguém acima, senão quem pede a exclusão aprova a própria exclusão.
--
-- COMO O CARGO FUNCIONA
--
-- Há um super admin ORIGINÁRIO — o Lerricke — e os demais, que ele promove.
-- A diferença entre os dois:
--
--   * só o originário promove e remove outros super admins;
--   * o originário não pode ser removido por ninguém, nem por si mesmo;
--   * um super admin promovido tem o cargo, mas não o poder de distribuí-lo.
--
-- CONSEQUÊNCIA QUE VOCÊ PRECISA SABER
--
-- Se o Lerricke sair da empresa ou perder o acesso, NINGUÉM consegue promover
-- mais ninguém. O cargo congela com quem já estiver nele. A única saída é SQL
-- direto aqui no Supabase:
--
--   update public.super_admins set originario = false where originario;
--   update public.super_admins set originario = true  where email = 'novo@...';
--
-- Isso é de propósito: quem tem acesso ao SQL Editor já tem poder total sobre
-- o banco, então não faz sentido travar essa porta. Mas é bom que o caminho
-- esteja escrito, e não descoberto no dia do aperto.
--
-- POR QUE UMA TABELA, E NÃO UMA COLUNA EM `profiles`
--
-- O caminho óbvio seria `profiles.is_super_admin`, no mesmo molde do
-- `is_admin`. O risco é concreto: se alguma política de UPDATE do `profiles`
-- deixar o usuário escrever na própria linha, a pessoa se promove sozinha e o
-- cargo não vale nada. Essa exata brecha existia em `domain_activity_logs` até
-- a migration de 24/09 — não é hipótese, é o padrão desta base.
--
-- Uma tabela nova com RLS ligado e NENHUMA política de escrita não tem como
-- ser escrita pelo cliente. Nem pelo dono da linha, nem por um admin, nem por
-- quem descobrir a chave anon. Só a service role do backend (que ignora RLS) e
-- as funções `security definer` abaixo entram.
--
-- O QUE ELA NÃO FAZ
--
-- Não altera `profiles`: nenhuma coluna entra, sai ou muda. Não toca em
-- `user_permissions`. Não muda nenhuma política existente. Não dá nem tira
-- permissão de ninguém.
-- =====================================================


-- -----------------------------------------------------
-- 1. ANTES: registre quem é admin hoje
-- -----------------------------------------------------

select id, email, full_name, is_admin, created_at
  from public.profiles
 where is_admin = true
 order by created_at;


-- -----------------------------------------------------
-- 2. A tabela do cargo
--
--    `on delete cascade`: se o usuário for apagado do auth, ele sai do cargo
--    junto. Sem isso sobraria um super admin fantasma apontando para um id
--    que não existe mais.
-- -----------------------------------------------------

create table if not exists public.super_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  nome        text not null,
  email       text not null,
  originario  boolean not null default false,
  criado_em   timestamptz not null default now(),
  criado_por  uuid references auth.users(id)
);

-- No máximo um originário. Sem isso, dois donos do cargo poderiam se remover
-- em looping, e a regra "ninguém rebaixa o originário" viraria letra morta.
create unique index if not exists super_admins_um_originario
  on public.super_admins ((true)) where originario;

comment on table public.super_admins is
  'Cargo acima de profiles.is_admin. Escrita só via definir_super_admin(). '
  'Não adicione políticas de INSERT/UPDATE/DELETE aqui: a ausência delas é a '
  'proteção contra alguém se promover sozinho.';


-- -----------------------------------------------------
-- 3. RLS: leitura para quem está logado, escrita para ninguém
--
--    A leitura precisa existir para o painel conseguir marcar quem é super
--    admin na tela de usuários. Saber QUEM é não é segredo; virar um é que
--    não pode.
--
--    Repare que não há `create policy` de insert, update ou delete. Isso é
--    intencional e é o coração desta migration.
-- -----------------------------------------------------

alter table public.super_admins enable row level security;

drop policy if exists "Autenticados veem quem e super admin" on public.super_admins;
create policy "Autenticados veem quem e super admin"
  on public.super_admins
  for select
  to authenticated
  using (true);


-- -----------------------------------------------------
-- 4. Consultas: é super admin? é o originário?
-- -----------------------------------------------------

create or replace function public.e_super_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.super_admins s where s.user_id = p_user_id);
$$;

create or replace function public.e_super_admin_originario(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.super_admins s
     where s.user_id = p_user_id and s.originario
  );
$$;

revoke all on function public.e_super_admin(uuid) from public;
revoke all on function public.e_super_admin_originario(uuid) from public;
grant execute on function public.e_super_admin(uuid) to authenticated;
grant execute on function public.e_super_admin_originario(uuid) to authenticated;


-- -----------------------------------------------------
-- 5. Escrita: o único caminho para entrar ou sair do cargo
--
--    Três travas dentro da função:
--
--    a) só o ORIGINÁRIO mexe no cargo. Nem admin comum, nem super admin
--       promovido. Quem ganhou o cargo não ganha o poder de distribuí-lo.
--
--    b) o originário não sai, nem removido por outro nem por ele mesmo. A
--       checagem é sobre o ALVO, então cobre os dois casos de uma vez.
--
--    c) ninguém vira originário por aqui. A função sempre insere com
--       `originario = false`; a troca de dono é SQL direto, como está escrito
--       no cabeçalho.
-- -----------------------------------------------------

create or replace function public.definir_super_admin(p_user_id uuid, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome  text;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado';
  end if;

  if not public.e_super_admin_originario(auth.uid()) then
    raise exception 'Só o super admin originário pode conceder ou remover este cargo';
  end if;

  if p_ativo then
    select p.full_name, p.email
      into v_nome, v_email
      from public.profiles p
     where p.id = p_user_id;

    if v_email is null then
      raise exception 'Usuário % não existe em profiles', p_user_id;
    end if;

    insert into public.super_admins (user_id, nome, email, originario, criado_por)
    values (p_user_id, coalesce(nullif(v_nome, ''), v_email), v_email, false, auth.uid())
    on conflict (user_id) do nothing;
  else
    if exists (select 1 from public.super_admins where user_id = p_user_id and originario) then
      raise exception 'O super admin originário não pode ser removido';
    end if;

    delete from public.super_admins where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.definir_super_admin(uuid, boolean) from public;
grant execute on function public.definir_super_admin(uuid, boolean) to authenticated;


-- -----------------------------------------------------
-- 6. O originário
--
--    Ovo e galinha: a função do passo 5 exige um originário para criar
--    qualquer super admin, então o primeiro entra por SQL direto, aqui. É
--    justamente por isso que esta migration roda no SQL Editor.
--
--    `criado_por` fica nulo: ninguém o promoveu.
-- -----------------------------------------------------

insert into public.super_admins (user_id, nome, email, originario, criado_por)
select u.id,
       coalesce(nullif(p.full_name, ''), u.email),
       u.email,
       true,
       null
  from auth.users u
  left join public.profiles p on p.id = u.id
 where lower(u.email) = lower('lerricke.nunes@institutoexperience.com.br')
on conflict (user_id) do nothing;


-- -----------------------------------------------------
-- 7. Confere, e falha alto se o e-mail não bater
--
--    Sem isto, um e-mail errado no passo 6 inseriria zero linhas em silêncio,
--    e você sairia achando que o cargo foi criado com alguém dentro.
-- -----------------------------------------------------

do $$
begin
  if not exists (select 1 from public.super_admins where originario) then
    raise exception
      'O cargo foi criado mas está SEM ORIGINÁRIO. O e-mail do passo 6 não bate com nenhum usuário em auth.users — confira se o Lerricke já tem conta no painel.';
  end if;
end;
$$;


-- -----------------------------------------------------
-- 8. Resultado
--
--    Esperado: uma linha, o Lerricke, com originario = true.
--    Repare no is_admin: o cargo NÃO dá permissão de painel. Se vier false,
--    ele vira um super admin que não enxerga as telas, e falta rodar o
--    toggle_user_admin antes.
-- -----------------------------------------------------

select s.nome, s.email, s.originario, s.criado_em, p.is_admin
  from public.super_admins s
  left join public.profiles p on p.id = s.user_id;

-- E a prova de que a escrita está fechada: esta consulta tem que voltar
-- apenas a política de SELECT. Se aparecer qualquer INSERT, UPDATE ou DELETE,
-- pare e me avise — a proteção não está de pé.
select policyname, roles, cmd
  from pg_policies
 where tablename = 'super_admins';
