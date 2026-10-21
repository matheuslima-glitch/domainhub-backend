-- =====================================================
-- PREÇO DE RENOVAÇÃO POR TERMINAÇÃO, VINDO DA NAMECHEAP
--
-- CRIA uma tabela. Não altera nenhuma existente, não toca `domains`, não
-- mexe em política nenhuma já no ar. O caminho de volta é um `drop table`
-- — ver o arquivo -rollback.
--
-- ── O QUE ISTO SUBSTITUI ─────────────────────────────────────────────────
--
-- Hoje o painel lê uma tabela de preços ESCRITA À MÃO, em
-- `src/lib/dashboard/precos.ts` do repositório `bluehost-ai`, capturada em
-- 29/09/2026. São 51 terminações digitadas uma a uma, e o próprio arquivo
-- avisa:
--
--   "um preço de tabela envelhecendo em silêncio é pior que um preço de
--    tabela datado"
--
-- e aponta o caminho: "Criar `tld_pricing` e trocar o corpo dessas duas
-- funções resolve o dashboard inteiro".
--
-- ── E É UM DADO MELHOR, NÃO SÓ MAIS NOVO ─────────────────────────────────
--
-- A Namecheap devolve dois números por terminação:
--
--   YourPrice           o preço DA CONTA, com os descontos que ela tem
--   YourAdditonalCost   a taxa ICANN  (o typo é deles, não nosso)
--
-- A tabela à mão tem preço de tabela PÚBLICA. Então isto não só deixa de
-- envelhecer: passa a dizer o que a conta realmente paga.
--
-- ── O QUE ISTO AINDA NÃO É ───────────────────────────────────────────────
--
-- Preço de TABELA da conta, não o contratado domínio a domínio. Um domínio
-- pego em promoção pode renovar por outro valor. Isso só fica exato quando
-- o fluxo de compra gravar o preço de renovação junto com o de registro, e
-- é outro trabalho.
--
-- ── POR QUE TERMINAÇÃO É A CHAVE, E POR QUE TEXTO ────────────────────────
--
-- A Namecheap precifica por terminação, não por domínio: `.com` custa o
-- mesmo para os 444 `.com` da base. Guardar por domínio seria repetir o
-- mesmo número 444 vezes e abrir espaço para eles divergirem.
--
-- A chave vem COM o ponto (".com", não "com") porque é assim que
-- `terminacaoDe()` devolve no painel, e é assim que a tela mostra. Gravar
-- sem o ponto obrigaria os dois lados a lembrar de colar e descolar.
-- =====================================================

-- -----------------------------------------------------
-- 1. A tabela
-- -----------------------------------------------------

create table if not exists public.tld_pricing (
  tld                text        primary key,

  -- Os dois componentes ficam SEPARADOS, e não só a soma, por dois motivos:
  -- dá para conferir linha a linha contra o painel da Namecheap, e a taxa
  -- ICANN muda por decisão de fora (ela subiu em 2025) — vendo o campo, a
  -- mudança aparece em vez de sumir dentro de um total.
  renovacao_usd      numeric(10,2) not null,
  taxa_icann_usd     numeric(10,2) not null default 0,

  -- O que de fato se paga. Coluna GERADA: não dá para alguém gravar uma
  -- soma que não bate com as parcelas.
  total_usd          numeric(10,2) generated always as
                       (renovacao_usd + taxa_icann_usd) stored,

  -- Quantos anos o preço cobre. A Namecheap devolve preço por duração e nós
  -- pegamos Duration="1"; o campo existe para a escolha ficar explícita no
  -- dado, não só no código do coletor.
  anos               smallint    not null default 1,

  atualizado_em      timestamptz not null default now()
);

comment on table public.tld_pricing is
  'Preço de renovação por terminação, coletado 1x/dia de namecheap.users.getPricing (ProductCategory=RENEW). Substitui a tabela escrita à mão em precos.ts. É preço de tabela DA CONTA (YourPrice), não o contratado por domínio.';

comment on column public.tld_pricing.tld is
  'Terminação COM o ponto: ".com", ".co.uk". Mesma forma que terminacaoDe() devolve no painel.';

comment on column public.tld_pricing.renovacao_usd is
  'YourPrice da Namecheap: o preço desta conta, já com desconto, SEM a taxa ICANN.';

comment on column public.tld_pricing.taxa_icann_usd is
  'YourAdditonalCost da Namecheap (o typo é deles). Zero nas terminações que não pagam ICANN — ccTLD como .co.uk e .de.';

comment on column public.tld_pricing.total_usd is
  'O que se paga para renovar um ano. Gerada: renovacao_usd + taxa_icann_usd.';

comment on column public.tld_pricing.atualizado_em is
  'Quando o coletor gravou esta linha. O painel MOSTRA esta data no lugar da constante PRECOS_CAPTURADOS_EM que existia antes.';


-- -----------------------------------------------------
-- 2. Leitura para o painel
-- -----------------------------------------------------
--
-- Diferente das tabelas vizinhas, esta NÃO é recortada por dono de dados:
-- preço de terminação é informação de catálogo, igual para todo mundo que
-- usa o sistema. Não há `user_id` para filtrar e inventar um seria criar
-- 51 cópias do mesmo número.
--
-- Por isso a política é "todo autenticado lê". Escrever continua sendo só
-- da service role, que é quem o coletor usa.

alter table public.tld_pricing enable row level security;

drop policy if exists "Authenticated can read tld pricing" on public.tld_pricing;

create policy "Authenticated can read tld pricing"
  on public.tld_pricing
  for select
  to authenticated
  using (true);

-- Redundante (a service role ignora RLS), mas deixa a tabela com a mesma
-- cara das vizinhas para quem for auditar as políticas.
drop policy if exists "Service role full access tld pricing" on public.tld_pricing;

create policy "Service role full access tld pricing"
  on public.tld_pricing
  for all
  to service_role
  using (true);

grant select on public.tld_pricing to authenticated;


-- -----------------------------------------------------
-- 3. Conferência depois de aplicar
-- -----------------------------------------------------
--
--   select tld, renovacao_usd, taxa_icann_usd, total_usd, atualizado_em
--     from public.tld_pricing
--    order by total_usd desc
--    limit 10;
--
-- Vazia logo depois de aplicar: quem preenche é o coletor, que roda às
-- 04:40 UTC. Para não esperar, dá para chamar na mão:
--
--   node -e "require('./src/services/namecheap/pricing').sincronizar()"
--
-- E o número que importa conferir contra a fatura, depois da primeira
-- coleta, é o `.com`: a base tem 444 deles e eles são 60% da renovação.
-- =====================================================
