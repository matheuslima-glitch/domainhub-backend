-- =====================================================
-- ONDE O DOMÍNIO ESTÁ HOSPEDADO: CLOUDFLARE E WHM
--
-- Três colunas em `domains`, escritas 1x por dia pelo backend a partir das
-- duas fontes: a lista de zonas da conta Cloudflare e a lista de contas do
-- WHM. Ver `src/services/presenca/`.
--
-- O QUE ELAS CONSERTAM
--
-- A aba "Sem acesso" do painel passou a exigir que o domínio esteja NOS DOIS
-- lugares para entrar na lista (pedido de 30/10/2026). O banco não sabia
-- responder nenhuma das duas perguntas:
--
--   Cloudflare  `zone_id` está preenchido em 8 de ~2.660 linhas. O coletor
--               diário não usa a coluna: pergunta as zonas à Cloudflare a
--               cada rodada e não grava a resposta.
--
--               A aba deduzia "tem zona" de `uniques_30d` não ser nulo, e a
--               dedução falha num caso: o coletor NÃO TOCA em domínio sem
--               zona. Um domínio que saiu da Cloudflare fica com a última
--               medição para sempre, e continuava parecendo medido.
--
--   WHM         Nada. O backend só consulta o WHM na hora de desativar ou
--               trocar um domínio.
--
-- "ESTAR NO WHM" É SER O DOMÍNIO PRINCIPAL DE UMA CONTA
--
-- O mesmo critério que a desativação e a troca já usam: o projeto cria uma
-- conta por domínio (`createacct`) e troca de domínio trocando o principal
-- (`modifyacct`); não usa addon nem parked. Conta SUSPENSA conta como
-- presente — a conta existe, e é ela que a exclusão removeria.
--
-- NULO NÃO É "NÃO ESTÁ"
--
-- `na_cloudflare` e `no_whm` nulos significam "ainda não conferido": linhas
-- de antes da primeira rodada, ou domínio comprado depois da última. O painel
-- trata nulo como motivo para ficar FORA da lista e conta à parte, para não
-- dizer "fora da Cloudflare" de um domínio que só não foi olhado ainda.
--
-- Uma rodada em que a Cloudflare ou o WHM falhe não escreve NADA: as colunas
-- ficam com a conferência anterior e `presenca_conferida_em` mostra a idade
-- dela. Gravar "não está" por causa de uma falha de rede tiraria a base
-- inteira da lista de uma vez.
--
-- REVERSA: 2026-10-30-presenca-cloudflare-whm-rollback.sql
-- =====================================================

alter table public.domains
  add column if not exists na_cloudflare         boolean,
  add column if not exists no_whm                boolean,
  add column if not exists presenca_conferida_em timestamptz;

comment on column public.domains.na_cloudflare is
  'Existe zona com este nome na conta Cloudflare, na última conferência. NULO = ainda não conferido, não "ausente". Escrita 1x/dia pelo backend (cron 0 5 * * *).';

comment on column public.domains.no_whm is
  'Existe conta no WHM cujo domínio PRINCIPAL é este, na última conferência (suspensa conta como presente). NULO = ainda não conferido. Escrita junto com na_cloudflare.';

comment on column public.domains.presenca_conferida_em is
  'Quando na_cloudflare e no_whm foram escritas. Data velha significa que a conferência parou de rodar ou está falhando.';
