-- =====================================================
-- REQUISIÇÕES DO MÊS DE REFERÊNCIA — para a comparação ser honesta
--
-- Rode no SQL Editor do Supabase. Uma coluna, aditiva, nada existente é tocado.
--
-- Reversão: incluída no rollback de 2026-09-10-visitantes-unicos-rollback.sql
--
-- O PROBLEMA QUE ISTO RESOLVE
--
-- O painel mostraria `monthly_visits` e `monthly_uniques` lado a lado, e em 98
-- domínios (10,1% dos 969 medidos) a segunda seria MAIOR que a primeira. Mais
-- pessoas do que requisições é impossível: toda pessoa gera ao menos uma.
--
-- Os números não estão errados — a comparação é que está. As duas colunas falam
-- de meses diferentes:
--
--   monthly_visits ... fotografia da importação de 15/08/2026, e o mês varia de
--                      LINHA PARA LINHA. Uma tem valor de março, outra de julho.
--                      Descobrir qual exige comparar o valor com as 24 colunas
--                      de `domain_analytics`.
--   monthly_uniques .. mês fechado mais recente, com certeza, porque o coletor
--                      acabou de medir.
--
-- Exemplo real, medido em 11/09/2026:
--
--   focusvibehealth.com
--     monthly_visits (congelado) ......   135.576   <- mês desconhecido
--     requisições de 08/2026 .......... 1.670.390
--     visitantes únicos de 08/2026 ....   722.982
--
-- Contra as requisições do MESMO mês, a contradição desaparece: medido em 969
-- domínios, zero casos de únicos maiores que requisições.
--
-- A SOLUÇÃO
--
-- Guardar também as requisições do mês que `monthly_uniques_ref` indica. O
-- painel passa a comparar agosto com agosto, e `monthly_visits` segue intocada
-- como coluna legada — ninguém perde o número a que já está acostumado.
--
-- O dado já existe em `domain_monthly_stats`; esta coluna é um espelho, para o
-- painel não precisar de join a cada linha da listagem.
-- =====================================================

alter table public.domains
  add column if not exists monthly_requests bigint;

comment on column public.domains.monthly_requests is
  'Requisições no mês indicado por monthly_uniques_ref. Par honesto de monthly_uniques — ao contrário de monthly_visits, que é congelada e de mês variável.';


-- -----------------------------------------------------
-- Preenchimento
-- -----------------------------------------------------
--
-- Roda a partir de `domain_monthly_stats`, que o backfill já preencheu. Não
-- precisa consultar a Cloudflare de novo.
--
-- Alternativa: `node -e "require('./src/services/cloudflare/monthly').fecharMes(1)"`,
-- que refaz o espelho consultando a origem. Leva ~4 minutos; este update é
-- instantâneo e chega no mesmo resultado.

update public.domains d
set monthly_requests = s.requests
from public.domain_monthly_stats s
where s.domain_id = d.id
  and d.monthly_uniques_ref is not null
  and s.ano = extract(year  from d.monthly_uniques_ref)::smallint
  and s.mes = extract(month from d.monthly_uniques_ref)::smallint;


-- -----------------------------------------------------
-- Conferência
-- -----------------------------------------------------

-- Quantos domínios ficaram com o par completo, e quantos ainda contradizem.
-- A segunda contagem TEM de ser zero.
select
  count(*)                                                          as com_uniques,
  count(monthly_requests)                                           as com_par_do_mesmo_mes,
  count(*) filter (where monthly_uniques > monthly_requests)        as contradicoes_no_par_novo,
  count(*) filter (where monthly_uniques > monthly_visits)          as contradicoes_contra_a_coluna_antiga
from public.domains
where monthly_uniques is not null;

-- Os três números lado a lado, nos maiores. `monthly_visits` fora de escala em
-- algumas linhas é esperado: ela é de outro mês.
select domain_name,
       monthly_visits   as visitas_congelado,
       monthly_requests as requisicoes_do_mes,
       monthly_uniques  as visitantes_do_mes,
       monthly_uniques_ref as mes
from public.domains
where monthly_uniques is not null
order by monthly_uniques desc
limit 10;
