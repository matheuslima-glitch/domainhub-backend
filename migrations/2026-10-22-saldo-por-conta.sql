-- =====================================================
-- SALDO DETALHADO POR CONTA DA NAMECHEAP
--
-- ACRESCENTA uma coluna anulável. Não altera nenhuma existente. O caminho
-- de volta é um `drop column` — ver o arquivo -rollback.
--
-- ── O BURACO QUE ISTO TAPA ───────────────────────────────────────────────
--
-- Desde 22/10/2026 o sistema soma o saldo de duas contas: a principal e a
-- do Paulo. Mas `namecheap_balance` só tem o TOTAL.
--
-- O detalhe por conta era calculado pelo backend, devolvido na resposta da
-- rota... e DESCARTADO na hora de gravar. O painel não lê a rota, lê esta
-- tabela — então a tela mostrava "US$ 136,78" como se fosse uma conta só.
--
-- ── POR QUE ISSO É PERIGOSO, E NÃO SÓ INCOMPLETO ─────────────────────────
--
-- Em 22/10/2026 a principal tinha US$ 36,78 e a do Paulo, US$ 100. A
-- principal recebe DUAS de cada três compras — ela seca primeiro.
--
-- Quando secar, a tela continuaria mostrando um total saudável de US$ 100
-- enquanto dois terços das compras falham por saldo. Um número que esconde
-- a conta vazia atrás da cheia é pior do que não ter número.
--
-- ── POR QUE jsonb, E NÃO UMA COLUNA POR CONTA ────────────────────────────
--
-- Porque o número de contas muda. `balance_principal` e `balance_paulo`
-- exigiriam migration a cada conta nova, e o nome da coluna carregaria o
-- nome de uma pessoa — que muda de emprego.
--
-- O formato é `[{"conta":"principal","usd":36.78,"erro":null}, ...]`, o
-- mesmo que `getBalance()` já devolve. `erro` não nulo significa que
-- AQUELA conta não respondeu: `usd` vem nulo, e nulo não é zero — zero
-- diria "sem dinheiro", que é outra informação.
-- =====================================================

alter table public.namecheap_balance
  add column if not exists por_conta jsonb;

comment on column public.namecheap_balance.por_conta is
  'Saldo de cada conta Namecheap: [{"conta":"principal","usd":36.78,"erro":null}]. O total nas colunas balance_usd/brl é a SOMA destas. usd nulo com erro preenchido = aquela conta não respondeu (nulo não é zero). NULO na coluna inteira = gravado antes de 22/10/2026, quando só havia uma conta.';


-- -----------------------------------------------------
-- Conferência depois de aplicar
-- -----------------------------------------------------
--
--   select balance_usd, por_conta, last_synced_at
--     from public.namecheap_balance;
--
-- `por_conta` vem NULO até a próxima coleta de saldo, que roda de 2 em 2
-- horas aos :30. Para não esperar, `GET /api/balance` grava na hora.
-- =====================================================
