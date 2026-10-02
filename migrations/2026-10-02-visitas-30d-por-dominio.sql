-- =====================================================
-- VISITAS DOS ÚLTIMOS 30 DIAS, POR DOMÍNIO
--
-- Uma linha por domínio, somando `domain_daily_stats`. É o que a coluna
-- "Visitas (30d)" do Gerenciamento passa a mostrar, no lugar da antiga
-- "Visitas/Mês".
--
-- POR QUE ELA EXISTE
--
-- Aquela coluna lê `domains.monthly_visits`, que é a importação congelada de
-- 15/08/2026. Nada escreve nela desde então: domínio criado depois mostra 0, e
-- domínio antigo mostra o número de um mês que varia de linha para linha. O
-- próprio código já dizia isso — ver o cabeçalho de `lib/exportDomains.ts` no
-- repositório do painel.
--
-- O dado vivo equivalente já existe: `domain_daily_stats`, escrita todo dia
-- pelo coletor da Cloudflare. Faltava a soma por domínio.
--
-- POR QUE UMA VIEW E NÃO UMA COLUNA EM `domains`
--
-- `select("*")` em `domains` aparece em seis lugares do painel. Coluna nova
-- ali chega a todos eles sem ninguém pedir. A view é lida só por quem a
-- nomeia, e é descartável — some com um `drop view`, sem tocar em dado.
--
-- ELA NÃO MUDA O COLETOR. Nenhuma chamada nova à Cloudflare, nenhuma cota
-- nova, nenhum horário novo. É leitura sobre uma tabela que já é escrita.
--
-- A JANELA
--
-- `data >= current_date - 30` cobre de ontem-29 até ontem: trinta dias, em
-- UTC, que é o fuso em que a Cloudflare fecha o dia e em que a coluna `data`
-- é gravada. O dia corrente nunca entra porque o coletor nunca o grava — ele
-- pede 14 dias FECHADOS terminando ontem (`janela()` em
-- `src/services/cloudflare/analytics.js`).
--
-- AUSÊNCIA DE LINHA SIGNIFICA DUAS COISAS, E ELAS PRECISAM SER SEPARADAS
--
-- Medido em 02/10/2026, na primeira rodada real do coletor: das 7.654 linhas
-- de `domain_daily_stats`, NENHUMA tem `requests = 0`. A GraphQL da
-- Cloudflare OMITE o dia sem acesso em vez de devolvê-lo zerado.
--
-- Então domínio parado é consultado todo dia e mesmo assim não aparece nesta
-- view. Ausência aqui pode ser "não teve acesso" OU "não é medido" — e a
-- diferença entre as duas é o que faz alguém decidir excluir um domínio.
--
-- O DESEMPATE ESTÁ FORA DESTA VIEW: `domains.views_14d` é escrita para todo
-- domínio que o coletor processa, inclusive com valor 0. Logo:
--
--   linha aqui                      -> a soma
--   sem linha, views_14d preenchida -> 0, medimos e não teve acesso
--   sem linha, views_14d nula       -> "—", nunca medido (sem zona)
--
-- `dias` vem junto por outro motivo: um domínio com 3 dias medidos não deve
-- ter o número lido como se fossem 30.
--
-- O ÚNICO NÃO É SOMADO AQUI, DE PROPÓSITO
--
-- Visitante único é deduplicado pela Cloudflare DENTRO de cada dia. Somar os
-- dias conta de novo quem voltou, e a inflação medida neste projeto vai de
-- 1,03x a 3,71x. Por isso esta view expõe a MÉDIA por dia, que é um valor
-- correto, e não uma soma, que não seria. Para o único de um período inteiro,
-- pergunte o período à Cloudflare numa consulta sem `dimensions { date }`.
--
-- REVERSA: 2026-10-02-visitas-30d-por-dominio-rollback.sql
-- =====================================================

create or replace view public.domain_30d_totals
with (security_invoker = true) as
select
  domain_id,
  sum(requests)::bigint        as requests,
  -- Média, não soma. Ver o cabeçalho.
  round(avg(uniques))::bigint  as uniques_media_dia,
  count(*)::int                as dias,
  min(data)                    as de,
  max(data)                    as ate
from public.domain_daily_stats
where data >= current_date - 30
group by domain_id;

comment on view public.domain_30d_totals is
  'Requisições dos últimos 30 dias por domínio, somadas de domain_daily_stats. Domínio AUSENTE pode ser "sem acesso" ou "não medido" — a Cloudflare omite o dia zerado; use domains.views_14d para desempatar. `dias` diz quantos dias da janela têm linha.';

comment on column public.domain_30d_totals.requests is
  'Soma das requisições dos dias medidos. Requisição é evento, então somar entre dias é exato.';

comment on column public.domain_30d_totals.uniques_media_dia is
  'MÉDIA de visitantes únicos por dia. Não é o total de pessoas do período: único é deduplicado dentro de cada dia, e somar os dias infla de 1,03x a 3,71x.';

comment on column public.domain_30d_totals.dias is
  'Em quantos dos 30 dias o domínio RECEBEU ACESSO — não quantos dias foram medidos. A Cloudflare omite o dia sem acesso, então um domínio consultado todos os dias que teve visita em um só aparece aqui com dias = 1.';

-- `security_invoker` faz a view respeitar a política de `domain_daily_stats`
-- em vez de rodar com os poderes do dono e passar por cima dela.
grant select on public.domain_30d_totals to authenticated;
