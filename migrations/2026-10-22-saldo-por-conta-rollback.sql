-- =====================================================
-- ROLLBACK — SALDO POR CONTA
--
-- Desfaz `2026-10-22-saldo-por-conta.sql`.
--
-- ── O QUE SE PERDE ───────────────────────────────────────────────────────
--
-- Só o detalhe do último retrato. Não é perda real: o saldo é recoletado
-- de 2 em 2 horas, e o total nas colunas `balance_usd` / `balance_brl`
-- continua intacto.
--
-- ── ANTES DE RODAR ───────────────────────────────────────────────────────
--
-- Reverta o PR do painel que exibe "Conta principal / Conta secundária".
-- Sem isso a tela tenta ler uma coluna que não existe — ela trata ausência
-- e volta a mostrar só o total, mas a leitura passa a logar erro a cada
-- carregamento.
-- =====================================================

alter table public.namecheap_balance
  drop column if exists por_conta;
