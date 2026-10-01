-- =====================================================
-- SÉRIE DIÁRIA DE TRÁFEGO POR DOMÍNIO
--
-- Espelha `domain_monthly_stats`, trocando (ano, mes) por (data).
--
-- POR QUE ELA EXISTE
--
-- Duas coisas que a série mensal não resolve:
--
--   1. O FILTRO "sem acesso há 60 dias". O mensal só ganha linha quando o mês
--      FECHA (cron '0 6 2 * *'), então o mês corrente nunca está lá. Em
--      01/10, perguntar "teve acesso nos últimos 60 dias?" ao mensal deixaria
--      setembro inteiro de fora.
--
--   2. RESOLUÇÃO EM JANELA CURTA. A aba "1 mês" do dashboard desenha um ponto
--      só, porque é um mês = uma linha. Com o diário, vira ~30 pontos.
--
-- DE ONDE VEM O DADO — SEM CHAMADA NOVA
--
-- O coletor diário (`src/services/cloudflare/analytics.js`, cron '20 5 * * *')
-- JÁ pede a quebra por dia: `dimensions { date }`, 14 dias por zona. Hoje ele
-- usa isso para calcular `views_14d` e joga o detalhe fora. Esta tabela é o
-- detalhe que já chega, guardado.
--
-- ATENÇÃO AO SOMAR — A RESSALVA QUE DECIDE O DESENHO
--
--   `requests` SOMA. Cada requisição é um evento; 10 na segunda e 8 na terça
--   são 18 em dois dias. Exato.
--
--   `uniques` NÃO SOMA. O "único" é único DENTRO do período consultado. Quem
--   visita segunda e terça conta 1 em cada dia, e a soma dá 2 — mas pessoas
--   distintas foram 1. Medido contra a janela deduplicada da Cloudflare, a
--   soma dos dias infla de 1,03x a 3,71x conforme o público volte mais ou
--   menos (ver o comentário de `consultarJanela`).
--
-- Por isso:
--   - o FILTRO de 60 dias usa `requests`, não `uniques`;
--   - o único de QUALQUER período é perguntado à Cloudflare naquele período,
--     nunca somado daqui;
--   - `domain_monthly_stats` continua existindo e é a fonte do único mensal.
--
-- Guardamos `uniques` do dia mesmo assim porque o valor de cada dia É
-- correto, e serve para o gráfico diário e para a média por dia.
--
-- REVERSA: 2026-10-01-views-diarias-rollback.sql
-- =====================================================


-- -----------------------------------------------------
-- 1. A tabela
-- -----------------------------------------------------
--
-- Sem linha significa NÃO MEDIDO, nunca zero. Zona que a Cloudflare devolve
-- sem dado não vira linha — a mesma regra da tabela mensal. Um domínio sem
-- linha num dia é um dia sem medição, e o filtro de 60 dias precisa saber a
-- diferença entre "não teve acesso" e "não olhamos".

create table if not exists public.domain_daily_stats (
  domain_id   uuid        not null references public.domains(id) on delete cascade,
  data        date        not null,

  requests    bigint,
  uniques     bigint,

  coletado_em timestamptz not null default now(),

  primary key (domain_id, data)
);

comment on table public.domain_daily_stats is
  'Série DIÁRIA por domínio, escrita pelo coletor da Cloudflare a partir da quebra por data que ele já busca. Ausência de linha = não medido.';

comment on column public.domain_daily_stats.requests is
  'Requisições do dia. SOMA corretamente entre dias — é o que o filtro de 60 dias usa.';

comment on column public.domain_daily_stats.uniques is
  'Visitantes únicos DAQUELE DIA. Cada valor é correto, mas NÃO SOME entre dias: a soma infla de 1,03x a 3,71x. Para único de um período, pergunte o período à Cloudflare.';


-- -----------------------------------------------------
-- 2. Índices
-- -----------------------------------------------------
--
-- A chave primária (domain_id, data) já serve "a série de um domínio".
-- Faltam dois acessos:
--
--   (a) "um dia de todos os domínios" — o que a view agregada faz;
--   (b) "quem não teve acesso desde X" — varredura por data com filtro de
--       requests, que é o filtro de 60 dias.

create index if not exists domain_daily_stats_data_idx
  on public.domain_daily_stats (data desc);

-- Índice parcial: só as linhas COM acesso. O filtro de 60 dias pergunta
-- "existe algum dia com requests > 0 depois de X?", e essa resposta só olha
-- as linhas com tráfego. Num portfólio em que a maioria dos domínios está
-- parada, o índice parcial é uma fração do tamanho do completo.
create index if not exists domain_daily_stats_com_acesso_idx
  on public.domain_daily_stats (domain_id, data desc)
  where requests > 0;


-- -----------------------------------------------------
-- 3. Permissão de leitura para o painel
-- -----------------------------------------------------
--
-- Espelha a política de `domain_monthly_stats`: o usuário só enxerga o que
-- pertence ao seu dono de dados, pelo join de chave estrangeira.
--
-- O coletor não depende disto — usa a service role, que passa por cima de
-- RLS. Isto existe para o painel conseguir ler.

alter table public.domain_daily_stats enable row level security;

drop policy if exists "Users can view accessible daily stats" on public.domain_daily_stats;

create policy "Users can view accessible daily stats"
  on public.domain_daily_stats
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.domains d
      where d.id = domain_daily_stats.domain_id
        and d.user_id = get_data_owner_id()
    )
  );

-- Redundante (a service role ignora RLS), mas deixa a tabela com a mesma
-- cara das vizinhas para quem for auditar as políticas.
drop policy if exists "Service role full access daily stats" on public.domain_daily_stats;

create policy "Service role full access daily stats"
  on public.domain_daily_stats
  for all
  to service_role
  using (true);


-- -----------------------------------------------------
-- 4. Total por dia — view para o Dashboard
-- -----------------------------------------------------
--
-- Sem ela, o gráfico de "1 mês" leria 601 domínios x 30 dias = ~18 mil
-- linhas. Com ela, lê 30.
--
-- `security_invoker` faz a view respeitar a política da tabela de baixo, em
-- vez de rodar com os poderes do dono e passar por cima dela.

create or replace view public.daily_totals
with (security_invoker = true) as
select
  data,
  sum(requests)::bigint as requests,
  sum(uniques)::bigint  as uniques,
  count(*)::int         as dominios
from public.domain_daily_stats
group by data;

comment on view public.daily_totals is
  'Soma diária sobre os domínios. O `uniques` aqui é soma de únicos POR DOMÍNIO num dia — quem visitou dois domínios conta duas vezes, e somar estes valores entre DIAS infla ainda mais. Para único de um período, pergunte o período à Cloudflare.';

grant select on public.daily_totals to authenticated;
