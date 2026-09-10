-- =====================================================
-- VISITANTES ÚNICOS — ao lado das requisições, nunca no lugar delas
--
-- Rode no SQL Editor do Supabase ANTES de subir o deploy. Sem estas colunas o
-- coletor consulta a Cloudflare e falha na gravação, domínio por domínio.
--
-- Reversão: migrations/2026-09-10-visitantes-unicos-rollback.sql
--
-- POR QUE ESTA MIGRATION EXISTE
--
-- Tudo que o DomainHub chama de "visitas" é `requests` da Cloudflare: cada
-- ARQUIVO servido, não pessoa nem carregamento de página. Medido em 1.030 zonas
-- da conta, nos 14 dias fechados até 09/09/2026:
--
--   603.352.989 requisições  ->  7.324.466 visitantes únicos
--
-- Requisições são 82x o número de gente. E a razão NÃO é constante: varia de
-- 2,2x (focusvibehealth.com) a 1.125x (memopezilhealthy.com) conforme o peso da
-- página e o comportamento do público. Não existe fator de conversão, e por
-- isso o ranking de "maiores domínios" muda de ordem, não só de escala:
-- sodaslim.com é o 1º em requisições e o 8º em visitantes.
--
-- NADA É SUBSTITUÍDO. Decisão do time: as duas leituras convivem. `requests`
-- responde "quanto o site foi acionado"; `uniques` responde "quanta gente
-- esteve lá". As colunas antigas seguem intactas, com o mesmo nome, o mesmo
-- tipo e o mesmo significado.
--
-- NULL SIGNIFICA "NÃO MEDIDO", NUNCA "SEM ACESSO"
--
-- Mesma regra que o coletor de requisições já segue. Domínio sem zona na
-- Cloudflare não é tocado. Das 1.030 zonas, 942 (91,5%) têm visitante único
-- registrado; as 88 restantes estão paradas ou em "DNS only", e nesse caso a
-- Cloudflare não tem o que medir — hoje nem depois.
--
-- Gravar 0 nesses casos repetiria o erro que `monthly_visits` já comete, onde
-- 1.054 domínios aparecem com 0 por ausência de origem, não por falta de
-- tráfego.
-- =====================================================


-- -----------------------------------------------------
-- 1. Janela curta, em `domains` — espelha as três colunas de requisição
-- -----------------------------------------------------
--
-- Note que NÃO existe `last_unique_date`. Seria coluna redundante: o dia em que
-- o tráfego parou é o mesmo nas duas métricas, porque toda requisição vem de
-- algum visitante. `last_view_date`, que já existe, serve às duas — e
-- `uniques_last_day` se refere exatamente ao dia que ela indica.

alter table public.domains
  add column if not exists uniques_14d      bigint,
  add column if not exists uniques_last_day bigint;

comment on column public.domains.uniques_14d is
  'Visitantes únicos nos últimos 14 dias fechados (Cloudflare), deduplicados na janela inteira — NÃO é a soma dos dias. NULL = não medido.';

comment on column public.domains.uniques_last_day is
  'Visitantes únicos no dia indicado por last_view_date. Par de views_last_day, que conta requisições no mesmo dia.';


-- -----------------------------------------------------
-- 2. Mês corrente, em `domains` — par de `monthly_visits`
-- -----------------------------------------------------
--
-- `monthly_uniques_ref` não tem equivalente do lado das requisições, e é de
-- propósito. Hoje ninguém sabe a que mês `monthly_visits` se refere: o painel
-- precisa DESCOBRIR isso comparando o valor com as 24 colunas de
-- `domain_analytics` (ver resumirAnalytics() no frontend), e erra em 0,3% dos
-- casos. A coluna nova nasce dizendo seu próprio mês, e o problema não se
-- repete.

alter table public.domains
  add column if not exists monthly_uniques     bigint,
  add column if not exists monthly_uniques_ref date;

comment on column public.domains.monthly_uniques is
  'Visitantes únicos no último mês FECHADO. NULL = não medido. Par de monthly_visits, que conta requisições.';

comment on column public.domains.monthly_uniques_ref is
  'Primeiro dia do mês a que monthly_uniques se refere. Existe para não repetir a ambiguidade de monthly_visits, cujo mês precisa ser deduzido.';


-- -----------------------------------------------------
-- 3. Série mensal — tabela nova
-- -----------------------------------------------------
--
-- NÃO CONFUNDIR COM `domain_analytics`, que continua existindo e intocada:
--
--   domain_analytics ....... uma linha por domínio, 24 colunas de mês.
--                            Dado CONGELADO, importado de fora em 15/08/2026.
--                            Nenhum serviço escreve nela.
--   domain_monthly_stats ... uma linha por domínio E mês. Dado VIVO, escrito
--                            pelo coletor. Cresce sem teto de meses.
--
-- Guarda as DUAS métricas no mesmo registro, para que o painel possa mostrar
-- uma ao lado da outra sem cruzar tabelas.
--
-- Alcance do histórico, medido em amostra de 150 zonas:
--
--   08/2026  88% das zonas têm dado        01/2026  40%
--   07/2026  83%                           12/2025  23%
--   06/2026  75%                           11/2025  10%
--   05/2026  67%                           10/2025   8%
--   04/2026  54%                           ---------------------------------
--   03/2026  47%                           09/2025 e antes: fora da retenção
--   02/2026  40%                           (a Cloudflare recusa: 52 semanas)
--
-- A queda não é falha de coleta: são domínios que ainda não existiam. Por isso
-- mês sem dado simplesmente NÃO VIRA LINHA aqui — ausência de linha é
-- "não medido", e nunca aparece como zero em lugar nenhum.

create table if not exists public.domain_monthly_stats (
  domain_id     uuid        not null references public.domains(id) on delete cascade,
  ano           smallint    not null,
  mes           smallint    not null check (mes between 1 and 12),

  uniques       bigint,
  requests      bigint,
  page_views    bigint,

  coletado_em   timestamptz not null default now(),

  primary key (domain_id, ano, mes)
);

comment on table public.domain_monthly_stats is
  'Série mensal viva por domínio, escrita pelo coletor da Cloudflare. Não confundir com domain_analytics, que é a importação congelada de 15/08/2026.';

comment on column public.domain_monthly_stats.uniques is
  'Visitantes únicos no mês, deduplicados no mês inteiro — NÃO é a soma dos dias.';

comment on column public.domain_monthly_stats.requests is
  'Requisições no mesmo mês. Guardada junto para o painel comparar as duas leituras sem cruzar tabelas.';

-- O painel lista "os meses de um domínio" e "um mês de todos os domínios".
-- A chave primária já cobre o primeiro caso; este índice cobre o segundo.
create index if not exists domain_monthly_stats_periodo_idx
  on public.domain_monthly_stats (ano desc, mes desc);


-- -----------------------------------------------------
-- 4. Permissão de leitura para o painel
-- -----------------------------------------------------
--
-- ⚠️ CONFIRA ANTES DE RODAR: a política abaixo libera leitura para qualquer
-- usuário autenticado, que é o padrão mais comum. Se `domains` e
-- `domain_analytics` usarem regra diferente nesse projeto, ajuste para a mesma
-- regra delas — a consulta abaixo mostra o que elas fazem hoje:
--
--   select tablename, policyname, roles, cmd, qual
--   from pg_policies
--   where schemaname = 'public' and tablename in ('domains', 'domain_analytics');
--
-- O coletor do backend não depende disto: ele usa a service role, que passa
-- por cima de RLS. Isto existe só para o painel conseguir ler.

alter table public.domain_monthly_stats enable row level security;

drop policy if exists "leitura para autenticados" on public.domain_monthly_stats;

create policy "leitura para autenticados"
  on public.domain_monthly_stats
  for select
  to authenticated
  using (true);


-- -----------------------------------------------------
-- 5. Total por mês — view para o Dashboard
-- -----------------------------------------------------
--
-- O gráfico do Dashboard mostra a rede inteira, mês a mês. Sem esta view o
-- painel teria de baixar uma linha por domínio e por mês — ~10 mil linhas, o
-- que estoura o limite de 1.000 do PostgREST e obrigaria a paginar para somar
-- no navegador. A view devolve uma linha por mês.
--
-- ⚠️ LEIA O QUE ESTE NÚMERO É: soma dos visitantes de cada domínio.
--
-- NÃO é "quantas pessoas distintas visitaram a rede". Quem entrou em dois
-- domínios no mesmo mês é contado duas vezes, porque a dedução do Cloudflare
-- acontece dentro de cada zona. Não há como deduplicar entre zonas com este
-- dataset. O painel rotula a série de acordo, e a coluna `dominios` deixa ver
-- quantos entraram em cada mês.
--
-- security_invoker faz a view respeitar a política da tabela de baixo, em vez
-- de rodar com os poderes do dono e passar por cima dela.

create or replace view public.monthly_uniques_totals
with (security_invoker = true) as
select
  ano,
  mes,
  sum(uniques)::bigint  as uniques,
  sum(requests)::bigint as requests,
  count(*)::int         as dominios
from public.domain_monthly_stats
group by ano, mes;

comment on view public.monthly_uniques_totals is
  'Soma mensal por domínio. NÃO é visitante distinto na rede: quem visita dois domínios conta duas vezes.';

grant select on public.monthly_uniques_totals to authenticated;


-- -----------------------------------------------------
-- 6. Conferência — rode junto e verifique a saída
-- -----------------------------------------------------

-- Devem aparecer as quatro colunas novas em `domains`.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'domains'
  and column_name in ('uniques_14d', 'uniques_last_day', 'monthly_uniques', 'monthly_uniques_ref')
order by column_name;

-- Devem aparecer as colunas da tabela nova.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'domain_monthly_stats'
order by ordinal_position;

-- As colunas antigas devem continuar exatamente como estavam.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'domains'
  and column_name in ('monthly_visits', 'views_14d', 'last_view_date', 'views_last_day')
order by column_name;
