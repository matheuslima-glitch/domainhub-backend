-- =====================================================
-- HISTÓRICO DE RENOVAÇÃO DE DOMÍNIOS
--
-- CRIA uma tabela. Não altera nenhuma existente, não toca `domains`. O
-- caminho de volta é um `drop table` — ver o arquivo -rollback.
--
-- ── O QUE ISTO HABILITA ──────────────────────────────────────────────────
--
-- A renovação ESCOLHIDA: a equipe marca na tela quais domínios renovar, e o
-- backend chama `namecheap.domains.renew` em cada um. Hoje isso é feito à
-- mão no painel da Namecheap, domínio a domínio.
--
-- O auto-renew da Namecheap está DESLIGADO nos 608 domínios ativos —
-- conferido em 22/10/2026 e confirmado pela equipe, que renova manualmente.
-- Isso importa porque a API da Namecheap NÃO liga nem desliga auto-renew:
-- `AutoRenew` é campo só de leitura no `getList`. Se estivesse ligado, a
-- Namecheap renovaria sozinha e a escolha na tela não valeria de nada.
--
-- ── POR QUE UMA TABELA, E NÃO COLUNAS EM `domains` ───────────────────────
--
-- Um domínio renova muitas vezes. Guardar "último valor cobrado" na linha
-- do domínio responderia só sobre a última vez, e a pergunta que vale é
-- quanto aquele domínio JÁ CONSUMIU — que é o que decide se vale manter.
--
-- ── O NÚMERO QUE SÓ EXISTE AQUI ──────────────────────────────────────────
--
-- `cobrado_usd` vem do `ChargedAmount` da resposta da Namecheap: o que foi
-- REALMENTE debitado. Todo o resto do painel usa preço de TABELA, de
-- `tld_pricing`. São coisas diferentes — promoção, cupom e preço premium
-- fazem o cobrado divergir do de tabela.
--
-- Com o tempo, esta tabela vira a única fonte de custo real de renovação
-- que o sistema tem.
--
-- ── E SERVE DE TRAVA ─────────────────────────────────────────────────────
--
-- Renovação é COBRADA NA HORA e não é reembolsável. Clicar duas vezes, ou
-- um pedido repetido pela rede, gastaria de novo. Antes de renovar, o
-- backend consulta esta tabela: se aquele domínio foi renovado há pouco, a
-- chamada é recusada em vez de cobrada.
-- =====================================================

-- -----------------------------------------------------
-- 1. A tabela
-- -----------------------------------------------------

create table if not exists public.domain_renewals (
  id                 uuid        primary key default gen_random_uuid(),

  domain_id          uuid        not null references public.domains(id) on delete cascade,

  -- Denormalizado de propósito. `domain_id` cai junto com o domínio se ele
  -- for excluído, e aí o histórico de gasto sumiria junto — justamente de
  -- um domínio que custou dinheiro. O nome fica como registro contábil.
  domain_name        text        not null,

  anos               smallint    not null default 1,

  -- `ChargedAmount` da resposta. NULO quando a Namecheap não informou:
  -- nulo é "não sabemos", zero seria "foi de graça".
  cobrado_usd        numeric(10,2),

  -- Qual conta pagou (`principal`, `paulo`). Sem isto, com o rodízio
  -- ativo, não dá para conferir a fatura de cada conta.
  conta              text        not null,

  -- Identificadores da Namecheap, para cruzar com a fatura deles.
  order_id           text,
  transaction_id     text,

  expiracao_anterior date,
  expiracao_nova     date,

  -- Quem clicou. `auth.users`, não `profiles`: é quem autenticou.
  solicitado_por     uuid,

  renovado_em        timestamptz not null default now()
);

comment on table public.domain_renewals is
  'Uma linha por renovação feita pelo DomainHub via namecheap.domains.renew. Guarda o valor REALMENTE cobrado (ChargedAmount), diferente do preço de tabela de tld_pricing. Serve também de trava contra renovar o mesmo domínio duas vezes.';

comment on column public.domain_renewals.cobrado_usd is
  'ChargedAmount da Namecheap: o que foi debitado de verdade. NULO = não informado. Difere do preço de tabela quando há promoção, cupom ou preço premium.';

comment on column public.domain_renewals.domain_name is
  'Denormalizado: se o domínio for excluído, a linha de domains cai por cascade e o histórico de gasto sumiria junto. O nome preserva o registro contábil.';

comment on column public.domain_renewals.conta is
  'Apelido da conta Namecheap que pagou (principal, paulo). Ver src/services/namecheap/contas.js.';


-- -----------------------------------------------------
-- 2. Índices
-- -----------------------------------------------------
--
-- (a) "este domínio foi renovado há pouco?" — a trava contra cobrança
--     duplicada, consultada ANTES de cada renovação;
-- (b) "quanto gastamos de renovação no período" — o relatório.

create index if not exists domain_renewals_domain_idx
  on public.domain_renewals (domain_id, renovado_em desc);

create index if not exists domain_renewals_data_idx
  on public.domain_renewals (renovado_em desc);


-- -----------------------------------------------------
-- 3. Permissão de leitura para o painel
-- -----------------------------------------------------
--
-- Espelha a política de `domain_daily_stats`: o usuário só enxerga as
-- renovações de domínios que pertencem ao dono de dados dele.
--
-- Escrever é só da service role — o backend. O painel NUNCA grava aqui:
-- quem registra a renovação é quem a fez, e só o backend faz.

alter table public.domain_renewals enable row level security;

drop policy if exists "Users can view accessible renewals" on public.domain_renewals;

create policy "Users can view accessible renewals"
  on public.domain_renewals
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.domains d
      where d.id = domain_renewals.domain_id
        and d.user_id = get_data_owner_id()
    )
  );

drop policy if exists "Service role full access renewals" on public.domain_renewals;

create policy "Service role full access renewals"
  on public.domain_renewals
  for all
  to service_role
  using (true);

grant select on public.domain_renewals to authenticated;


-- -----------------------------------------------------
-- 4. Conferência depois de aplicar
-- -----------------------------------------------------
--
--   select count(*) from public.domain_renewals;
--
-- Zero logo depois de aplicar: quem preenche é a tela de renovação, a cada
-- domínio renovado.
-- =====================================================
