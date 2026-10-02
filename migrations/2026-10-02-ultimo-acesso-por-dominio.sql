-- =====================================================
-- ÚLTIMO ACESSO REGISTRADO, POR DOMÍNIO
--
-- Uma linha por domínio, com a data mais recente em que ele recebeu alguém.
-- É o que o filtro "sem acesso há 60 dias" do dashboard pergunta.
--
-- POR QUE NÃO DÁ PARA USAR `domains.last_view_date`
--
-- Apesar do nome, aquela coluna NÃO guarda a última vez que o domínio foi
-- visto. O coletor a reescreve a cada rodada com o último dia COM ACESSO
-- dentro dos 14 dias da janela — e com `null` quando não houve nenhum
-- (`calcular()` em `src/services/cloudflare/analytics.js`).
--
-- Ou seja: domínio que teve tráfego há 20 dias aparece lá como `null`, igual
-- a um que nunca teve. Quem usasse aquele campo para decidir exclusão
-- apagaria domínio vivo.
--
-- DE ONDE VEM A RESPOSTA, ENTÃO
--
-- De duas tabelas, porque nenhuma sozinha cobre 60 dias hoje:
--
--   `domain_daily_stats`  — começou em 02/10/2026 e cresce um dia por dia.
--                           Em 02/10 alcança 18/09. Resolução de DIA.
--   `domain_monthly_stats` — 12 meses de histórico. Resolução de MÊS.
--
-- O mensal vira data pelo ÚLTIMO dia do mês, não pelo primeiro: se houve
-- tráfego em agosto, o mais recente que ele pode ter sido é 31/08. Arredondar
-- para o fim erra para o lado de "teve acesso", e esse é o lado seguro —
-- ninguém é marcado para exclusão por arredondamento.
--
-- Conforme o diário cresce, ele domina sozinho: por volta de 17/11/2026
-- cobre os 60 dias inteiros e o mensal deixa de importar para esta conta.
--
-- NULO SIGNIFICA "NENHUM ACESSO REGISTRADO", NÃO "NUNCA MEDIDO"
--
-- As duas tabelas de origem só ganham linha quando há tráfego — medido em
-- 02/10/2026: das 7.654 linhas de `domain_daily_stats`, nenhuma tem
-- `requests = 0`, porque a Cloudflare omite o dia sem acesso.
--
-- Então `ultimo_acesso` nulo quer dizer que não existe registro de acesso em
-- nenhuma das duas. Para saber se o domínio é SEQUER MEDIDO, quem lê precisa
-- olhar `domains.views_14d`: o coletor a escreve para todo domínio que
-- processa, inclusive com 0. Nulo lá = sem zona na Cloudflare = não sabemos
-- nada sobre ele, e ele não pode entrar numa lista de candidatos a exclusão.
--
-- REVERSA: 2026-10-02-ultimo-acesso-por-dominio-rollback.sql
-- =====================================================

create or replace view public.domain_ultimo_acesso
with (security_invoker = true) as
with por_dia as (
  select domain_id, max(data) as ultimo_dia
    from public.domain_daily_stats
   where requests > 0
   group by domain_id
),
por_mes as (
  select domain_id, max(make_date(ano, mes, 1)) as primeiro_dia_do_mes
    from public.domain_monthly_stats
   where requests > 0
   group by domain_id
)
select
  d.id                                                          as domain_id,
  dia.ultimo_dia,
  -- O último dia do mês mais recente com tráfego. Ver o cabeçalho.
  (mes.primeiro_dia_do_mes + interval '1 month')::date - 1       as ultimo_dia_do_mes,
  -- `greatest` ignora nulos no Postgres, então basta um dos dois existir.
  greatest(
    dia.ultimo_dia,
    (mes.primeiro_dia_do_mes + interval '1 month')::date - 1
  )                                                              as ultimo_acesso
from public.domains d
left join por_dia dia on dia.domain_id = d.id
left join por_mes mes on mes.domain_id = d.id;

comment on view public.domain_ultimo_acesso is
  'Data do último acesso registrado por domínio, combinando domain_daily_stats (dia) e domain_monthly_stats (mês, arredondado para o último dia). NULO = nenhum acesso registrado, o que NÃO é o mesmo que nunca medido — cruze com domains.views_14d para saber se o domínio é sequer observado.';

comment on column public.domain_ultimo_acesso.ultimo_dia is
  'Último dia COM ACESSO na série diária. Só alcança 18/09/2026 para trás em 02/10/2026; a série cresce um dia por dia.';

comment on column public.domain_ultimo_acesso.ultimo_dia_do_mes is
  'Último dia do mês mais recente com tráfego na série mensal. Arredonda para o fim do mês de propósito: erra para "teve acesso", que é o lado que não marca ninguém para exclusão por engano.';

comment on column public.domain_ultimo_acesso.ultimo_acesso is
  'O mais recente entre os dois. É este que o filtro de 60 dias compara.';

grant select on public.domain_ultimo_acesso to authenticated;
