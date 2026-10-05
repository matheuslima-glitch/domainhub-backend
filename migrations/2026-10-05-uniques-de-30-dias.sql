-- =====================================================
-- VISITANTES ÚNICOS E REQUISIÇÕES DOS ÚLTIMOS 30 DIAS
--
-- Três colunas em `domains`, escritas pelo coletor diário a partir de uma
-- quarta consulta à Cloudflare: os 30 dias fechados terminando ontem.
--
-- O QUE ELAS CONSERTAM
--
-- A aba curta do dashboard mostrava dois números de PERÍODOS DIFERENTES lado
-- a lado, sem nada avisando:
--
--   Requisições        467,2 mi   somadas da série diária  → 18/09 a 04/10
--   Visitantes únicos    4,2 mi   do mês corrente          → 01/10 a 04/10
--
-- Dezessete dias contra quatro, sob uma aba chamada "30 dias", com o mesmo
-- gráfico embaixo dos dois. Agora os dois saem da MESMA consulta e cobrem o
-- mesmo período.
--
-- De quebra, as requisições passam a cobrir 30 dias de verdade desde já: a
-- série diária só alcança 17 (nasceu em 18/09/2026 e cresce um por dia), mas
-- a Cloudflare tem o histórico inteiro.
--
-- POR QUE NÃO DEU PARA DERIVAR DO QUE JÁ EXISTE
--
-- Já tínhamos três janelas deduplicadas: 14 dias, mês corrente e mês
-- fechado. Nenhuma é 30 dias, e elas NÃO SE COMBINAM — sabendo os únicos de
-- 14 dias e os do mês, não há como chegar aos de 30, porque a sobreposição
-- de pessoas entre os dois pedaços é desconhecida. É a mesma razão pela qual
-- somar os dias não funciona.
--
-- Requisições, sozinhas, dariam para somar da série diária. Mas vêm de graça
-- na mesma resposta, e assim os dois números saem do mesmo lugar e não têm
-- como divergir.
--
-- O CUSTO
--
-- Uma quarta consulta por lote de 10 zonas: ~61 chamadas a mais por rodada,
-- levando o total a ~244 contra o teto de 300 por 5 minutos. A API de
-- Analytics não é cobrada — medido: o `backfill:mensal` disparou ~1.133
-- consultas numa tacada só e a fatura seguiu zerada.
--
-- A pausa entre consultas subiu de 400ms para 1s junto com esta mudança, para
-- garantir o limite por duração mesmo que a Cloudflare responda instantânea.
-- Ver o comentário de PAUSA_ENTRE_CONSULTAS em analytics.js.
--
-- `stats_30d_ate` DIZ ATÉ QUANDO A JANELA VAI
--
-- É o último dia coberto, e serve de carimbo: se ele estiver velho, o coletor
-- parou de alcançar aquele domínio. Hoje nenhuma das colunas de tráfego tem
-- esse carimbo — um `views_14d` escrito há um mês é indistinguível de um
-- escrito hoje, e foram 406 domínios nessa situação em 05/10/2026.
--
-- REVERSA: 2026-10-05-uniques-de-30-dias-rollback.sql
-- =====================================================

alter table public.domains
  add column if not exists uniques_30d   bigint,
  add column if not exists requests_30d  bigint,
  add column if not exists stats_30d_ate date;

comment on column public.domains.uniques_30d is
  'Visitantes únicos dos últimos 30 dias fechados, DEDUPLICADOS pela Cloudflare na própria consulta. Não é soma de dias nem combinação de janelas menores — as duas coisas inflam. Escrita pelo coletor diário (cron 20 5 * * *).';

comment on column public.domains.requests_30d is
  'Requisições dos últimos 30 dias fechados. Vem da MESMA resposta que uniques_30d, para os dois números da aba curta do dashboard não poderem divergir.';

comment on column public.domains.stats_30d_ate is
  'Último dia coberto pela janela (sempre ontem, na rodada que a escreveu). Serve de carimbo: data velha significa que o coletor parou de alcançar este domínio.';

-- Ordenar o Gerenciamento por este número é o uso esperado, e a maioria da
-- base não tem zona na Cloudflare.
create index if not exists domains_uniques_30d_idx
  on public.domains (uniques_30d desc)
  where uniques_30d is not null;
