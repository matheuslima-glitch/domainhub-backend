-- =====================================================
-- EM QUE CONTA DA NAMECHEAP CADA DOMÍNIO FOI COMPRADO
--
-- ACRESCENTA uma coluna anulável. Não altera nenhuma existente, não mexe
-- em política, não reescreve linha nenhuma. O caminho de volta é um
-- `drop column` — ver o arquivo -rollback.
--
-- ── POR QUE ISTO PRECISA EXISTIR ─────────────────────────────────────────
--
-- As compras por IA vão passar a se dividir entre a conta principal e a do
-- Paulo, na proporção 2:1. Sem registrar QUEM comprou cada domínio, quatro
-- coisas quebram — e três delas em silêncio:
--
--   SINCRONIA   o cron de 4 em 4 horas usa `domains.getList`, que só
--               enxerga uma conta. Os domínios da outra param de ser
--               atualizados: expiração, lock e status congelam. Nada some
--               da tela, o dado só envelhece sem avisar.
--
--   NAMESERVER  `dns.setCustom` age sobre um domínio específico. Com a
--               credencial errada, a chamada falha.
--
--   getInfo     idem.
--
--   SALDO       o painel mostraria o dinheiro de uma conta só.
--
-- ── NULO QUER DIZER ALGO ─────────────────────────────────────────────────
--
-- `null` = comprado ANTES do rodízio existir, logo na conta principal.
-- São os ~2.700 domínios atuais, e eles NÃO são preenchidos por esta
-- migration de propósito.
--
-- Duas razões. A primeira é honestidade: ninguém verificou um por um, e
-- escrever `principal` em todos seria afirmar algo não conferido — ainda
-- que seja quase certo.
--
-- A segunda é funcional, e é a que decide. O rodízio conta quantas compras
-- cada conta recebeu DESDE QUE COMEÇOU, filtrando por
-- `registrar_account is not null`. Se esta migration carimbasse os 2.700
-- como `principal`, a razão dela ficaria altíssima e o rodízio mandaria as
-- próximas ~1.350 compras SEGUIDAS para a conta do Paulo, tentando
-- compensar um passado que não é para compensar.
--
-- Quem lê a coluna trata `null` como `principal`. Quem conta o rodízio
-- ignora `null`. São perguntas diferentes sobre a mesma ausência.
-- =====================================================

-- -----------------------------------------------------
-- 1. A coluna
-- -----------------------------------------------------
--
-- Texto, não enum nem chave estrangeira: a lista de contas vive em
-- `src/services/namecheap/contas.js`, não no banco. Um enum obrigaria uma
-- migration para cada conta nova, e uma tabela de contas guardaria
-- credencial no Postgres, que é pior.
--
-- O apelido é estável (`principal`, `paulo`) e não um índice numérico:
-- índice muda de significado se alguém reordenar a lista no código, e as
-- linhas antigas passariam a apontar para a conta errada em silêncio.

alter table public.domains
  add column if not exists registrar_account text;

comment on column public.domains.registrar_account is
  'Apelido da conta da Namecheap que comprou este domínio (`principal`, `paulo`), como definido em src/services/namecheap/contas.js. NULO = comprado antes do rodízio existir, ou seja, na principal. Quem LÊ trata nulo como principal; quem CONTA o rodízio ignora nulo, para o histórico não distorcer a proporção.';


-- -----------------------------------------------------
-- 2. Índice para a conta do rodízio
-- -----------------------------------------------------
--
-- A pergunta que o rodízio faz antes de cada compra é "quantos domínios
-- cada conta já recebeu?". Índice PARCIAL, só das linhas com conta
-- gravada: são as únicas que entram na contagem, e hoje elas são zero
-- contra ~2.700 linhas na tabela. O índice completo seria quase todo feito
-- de linhas que a consulta descarta.

create index if not exists domains_registrar_account_idx
  on public.domains (registrar_account)
  where registrar_account is not null;


-- -----------------------------------------------------
-- 3. Conferência depois de aplicar
-- -----------------------------------------------------
--
--   select registrar_account, count(*)
--     from public.domains
--    group by registrar_account;
--
-- Logo depois de aplicar, o esperado é UMA linha: `null` com o total da
-- base. Qualquer outra coisa quer dizer que alguma compra já gravou a
-- coluna — o que só deve acontecer depois do PR que liga o rodízio.
-- =====================================================
