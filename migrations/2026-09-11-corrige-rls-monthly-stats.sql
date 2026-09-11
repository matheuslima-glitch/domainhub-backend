-- =====================================================
-- CORREÇÃO DE RLS — domain_monthly_stats
--
-- Rode no SQL Editor do Supabase. Só é necessário para quem aplicou a primeira
-- versão de 2026-09-10-visitantes-unicos.sql, que criava a política de leitura
-- como `using (true)`. O arquivo original já nasce corrigido a partir de
-- 11/09/2026 — quem aplicar dali em diante não precisa deste script.
--
-- O QUE ESTAVA ERRADO
--
-- A política liberava leitura para QUALQUER usuário autenticado. As tabelas
-- vizinhas não fazem isso:
--
--   domains           using (user_id = get_data_owner_id())
--   domain_analytics  using (exists (select 1 from domains d
--                                    where d.domain_name = domain_analytics.domain_name
--                                      and d.user_id = get_data_owner_id()))
--   domain_monthly_stats   using (true)     <- fora do padrão
--
-- Na prática, um usuário de um dono de dados conseguiria ler a série mensal de
-- domínios de OUTRO dono. Nenhum dado vazou por isso ainda: quando esta
-- correção foi escrita a tabela estava vazia — o backfill ainda não tinha
-- rodado e o coletor ainda não havia subido.
--
-- ISTO NÃO AFETA O COLETOR. Ele grava com a service role, que passa por cima de
-- RLS. A política só governa o que o PAINEL consegue ler.
--
-- A VIEW ACOMPANHA SOZINHA. `monthly_uniques_totals` foi criada com
-- `security_invoker = true`, então ela aplica a política da tabela de baixo. Com
-- a correção, o gráfico do Dashboard passa a somar só os domínios que o usuário
-- pode ver — que é como o resto do painel já se comporta.
-- =====================================================


-- -----------------------------------------------------
-- 1. Antes: veja a política que está valendo
-- -----------------------------------------------------

select policyname, roles, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename = 'domain_monthly_stats';


-- -----------------------------------------------------
-- 2. Correção
-- -----------------------------------------------------
--
-- O join é por `domain_id`, e não pelo nome como em `domain_analytics`: aqui
-- existe chave estrangeira de verdade, que é mais barata e não sofre com os 68
-- domínios cadastrados em caixa mista.

drop policy if exists "leitura para autenticados" on public.domain_monthly_stats;
drop policy if exists "Users can view accessible monthly stats" on public.domain_monthly_stats;

create policy "Users can view accessible monthly stats"
  on public.domain_monthly_stats
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.domains d
      where d.id = domain_monthly_stats.domain_id
        and d.user_id = get_data_owner_id()
    )
  );

-- Espelha "Service role full access domains". Redundante na prática, porque a
-- service role já ignora RLS — existe para a tabela nova ter a mesma cara das
-- vizinhas numa auditoria de políticas.
drop policy if exists "Service role full access monthly stats" on public.domain_monthly_stats;

create policy "Service role full access monthly stats"
  on public.domain_monthly_stats
  for all
  to service_role
  using (true);


-- -----------------------------------------------------
-- 3. Conferência — a linha de leitura NÃO pode mais dizer "true"
-- -----------------------------------------------------

select
  policyname,
  roles,
  cmd,
  qual,
  case
    when cmd = 'SELECT' and qual = 'true' then '❌ ainda liberado para todos'
    when cmd = 'SELECT'                   then '✅ restrito ao dono dos dados'
    else '—'
  end as status
from pg_policies
where schemaname = 'public'
  and tablename = 'domain_monthly_stats'
order by cmd;


-- Comparação lado a lado com as vizinhas: as três linhas de SELECT para
-- `authenticated` devem ter formato equivalente.
select tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename in ('domains', 'domain_analytics', 'domain_monthly_stats')
  and cmd = 'SELECT'
  and roles::text like '%authenticated%'
order by tablename;
