-- =====================================================
-- REVERSÃO — desfaz 2026-09-10-visitantes-unicos.sql
--
-- Cole no SQL Editor do Supabase e rode. Volta o banco exatamente ao estado
-- anterior à migration de visitantes únicos.
--
-- ANTES DE RODAR ISTO, DESLIGUE A COLETA. Caso contrário o cron recria dado
-- em colunas que você acabou de remover e passa a falhar a cada rodada:
--
--   Render -> Environment -> COLETA_UNIQUES = false -> Save (reinicia sozinho)
--
-- Só depois rode este script.
--
-- É SEGURO. Nada aqui toca em `monthly_visits`, `views_14d`, `last_view_date`,
-- `views_last_day`, na tabela `domain_analytics` ou em qualquer coisa que já
-- existia antes de 10/09/2026. A migration foi aditiva por construção, então a
-- reversão só remove o que ela mesma criou.
--
-- O QUE SE PERDE: os visitantes únicos coletados desde o deploy, incluindo o
-- backfill. Nada disso é insubstituível — rodar a migration e o backfill de
-- novo recupera tudo o que ainda estiver dentro da retenção da Cloudflare
-- (52 semanas). O que estava fora da retenção na primeira coleta continuará
-- fora, e o que era recuperável continua recuperável.
-- =====================================================


-- -----------------------------------------------------
-- 1. Confira o que vai ser removido (rode antes, se quiser)
-- -----------------------------------------------------

-- Quantos domínios têm visitante único gravado hoje:
select
  count(*)                                          as dominios,
  count(uniques_14d)                                as com_uniques_14d,
  count(monthly_uniques)                            as com_mensal
from public.domains;

-- Quantas linhas de série mensal existem:
select
  count(*)                       as linhas,
  count(distinct domain_id)      as dominios,
  min(ano * 100 + mes)           as mes_mais_antigo,
  max(ano * 100 + mes)           as mes_mais_recente
from public.domain_monthly_stats;


-- -----------------------------------------------------
-- 2. Reversão
-- -----------------------------------------------------

-- A view depende da tabela, então cai primeiro.
drop view if exists public.monthly_uniques_totals;

drop index if exists public.domain_monthly_stats_periodo_idx;

drop table if exists public.domain_monthly_stats;

-- `monthly_requests` vem de 2026-09-11-requisicoes-do-mes.sql e cai junto: ela
-- só existe para dar par a `monthly_uniques`, e sem ela não serve para nada.
alter table public.domains
  drop column if exists uniques_14d,
  drop column if exists uniques_last_day,
  drop column if exists monthly_uniques,
  drop column if exists monthly_uniques_ref,
  drop column if exists monthly_requests;


-- -----------------------------------------------------
-- 3. Conferência — as duas consultas devem voltar VAZIAS
-- -----------------------------------------------------

-- Nenhuma coluna de uniques deve sobrar em `domains`.
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'domains'
  and column_name in ('uniques_14d', 'uniques_last_day', 'monthly_uniques',
                      'monthly_uniques_ref', 'monthly_requests');

-- Nem a tabela nem a view devem mais existir.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('domain_monthly_stats', 'monthly_uniques_totals');


-- -----------------------------------------------------
-- 4. E estas devem continuar INTACTAS — quatro linhas
-- -----------------------------------------------------

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'domains'
  and column_name in ('monthly_visits', 'views_14d', 'last_view_date', 'views_last_day')
order by column_name;
