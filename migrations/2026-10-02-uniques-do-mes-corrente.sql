-- =====================================================
-- VISITANTES ÚNICOS DO MÊS CORRENTE
--
-- Três colunas em `domains`, escritas pelo coletor diário a partir de uma
-- consulta nova à Cloudflare: o mês em andamento, do dia 1 até ontem.
--
-- O BURACO QUE ELAS FECHAM
--
-- `domains.monthly_uniques` só ganha valor quando o mês FECHA — o cron é
-- '0 6 2 * *' e grava o mês anterior. Durante os ~30 dias de um mês corrente
-- não existe, em lugar nenhum do sistema, quantas pessoas visitaram um
-- domínio naquele mês. Em 02/10/2026 o painel mostrava setembro, e ia mostrar
-- setembro até 02/11.
--
-- POR QUE NÃO DÁ PARA SOMAR A SÉRIE DIÁRIA
--
-- `domain_daily_stats` tem o único de cada dia, e cada um está correto. Mas
-- único é deduplicado DENTRO do período consultado: quem visita segunda e
-- terça conta 1 em cada dia, e a soma dá 2 para uma pessoa só. Medido neste
-- projeto, a inflação vai de 1,03x a 3,71x conforme o público volte mais ou
-- menos.
--
-- Requisições, sim, poderiam ser somadas de lá — mas vêm junto na mesma
-- resposta da Cloudflare, de graça, e assim as duas saem do mesmo lugar e não
-- há como divergirem.
--
-- DE ONDE VEM O DADO
--
-- De `consultarJanela()`, a mesma função que já traz o total dos 14 dias. A
-- consulta não tem `dimensions { date }`, e é essa ausência que faz a
-- Cloudflare deduplicar o período inteiro em vez de fechar dia a dia. Só o
-- período muda.
--
-- Custo: uma terceira consulta por lote de 10 zonas. Com ~601 zonas são ~61
-- chamadas a mais por rodada, levando o total a ~183 — dentro da cota de 300
-- por 5 minutos. A API de Analytics não é cobrada.
--
-- O MÊS É O DE ONTEM, NÃO O DE HOJE
--
-- No dia 1º o mês de hoje ainda não tem nenhum dia fechado, e a janela sairia
-- invertida. Ancorado em ontem: em 01/11 estas colunas trazem outubro
-- inteiro, e em 02/11 — quando o cron mensal grava outubro como fechado —
-- elas já passaram para novembro. A troca acontece sozinha, sem buraco e sem
-- os dois meses se sobreporem.
--
-- `mes_corrente_ref` diz a que mês o valor pertence. Sem ela, quem lê não tem
-- como saber se o coletor rodou depois da virada do mês — e mostraria o mês
-- passado achando que é o atual.
--
-- REVERSA: 2026-10-02-uniques-do-mes-corrente-rollback.sql
-- =====================================================

alter table public.domains
  add column if not exists uniques_mes_corrente  bigint,
  add column if not exists requests_mes_corrente bigint,
  add column if not exists mes_corrente_ref      date;

comment on column public.domains.uniques_mes_corrente is
  'Visitantes únicos do mês corrente, do dia 1 até ontem, DEDUPLICADOS pela Cloudflare na própria consulta. Não é soma de dias — somar dias infla de 1,03x a 3,71x. Escrita pelo coletor diário (cron 20 5 * * *).';

comment on column public.domains.requests_mes_corrente is
  'Requisições do mês corrente, do dia 1 até ontem. Vem da MESMA resposta da Cloudflare que uniques_mes_corrente, para as duas não poderem divergir.';

comment on column public.domains.mes_corrente_ref is
  'Primeiro dia do mês a que as duas colunas acima se referem. Serve para o leitor saber se o coletor rodou depois da virada do mês: ref de setembro em 15/10 significa coletor parado há duas semanas.';

-- Índice só para quem tiver medição: ordenar o Gerenciamento por este número
-- é o uso esperado, e a maioria dos domínios da base não tem zona.
create index if not exists domains_uniques_mes_corrente_idx
  on public.domains (uniques_mes_corrente desc)
  where uniques_mes_corrente is not null;
