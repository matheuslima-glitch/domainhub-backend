/**
 * EM QUE CONTA ESTE DOMÍNIO FOI COMPRADO
 *
 * Lê `domains.registrar_account`. Separado de `contas.js` de propósito:
 * aquele módulo é puro e não toca banco, o que é o que permite provar o
 * rodízio sem credencial. Este precisa do Supabase, então mora à parte.
 *
 * ── NULO É RESPOSTA, NÃO FALHA ───────────────────────────────────────────
 *
 * Domínio sem conta gravada foi comprado ANTES do rodízio existir — são os
 * ~2.700 atuais — e esses estão todos na principal. Então nulo devolve
 * `principal`, que é a verdade sobre eles.
 *
 * O mesmo vale para domínio que não está na nossa tabela: usar a principal
 * é o palpite certo, e é o que o sistema fazia antes de haver escolha.
 *
 * Note que esta é a leitura OPOSTA à do rodízio: lá, nulo é IGNORADO, para
 * o histórico não distorcer a proporção. São perguntas diferentes sobre a
 * mesma ausência — "de quem é este?" e "quantos cada uma já recebeu?".
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const contas = require('./contas');

let supabase = null;
function banco() {
  if (!supabase) {
    supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

/**
 * O apelido da conta de um domínio. Nunca lança.
 *
 * Falha de leitura também devolve `principal`: deixar a troca de nameserver
 * cair porque o banco piscou seria pior do que tentar na conta mais
 * provável. O erro vai para o log.
 */
async function contaDoDominio(domainName) {
  // Com uma conta só não há o que consultar — e esta é a situação até as
  // credenciais do Paulo entrarem no Render. Evita uma ida ao banco por
  // chamada, em troca de nada.
  if (!contas.temRodizio()) return contas.PRINCIPAL;

  try {
    const { data, error } = await banco()
      .from('domains')
      .select('registrar_account')
      .eq('domain_name', String(domainName || '').trim().toLowerCase())
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data?.registrar_account || contas.PRINCIPAL;
  } catch (e) {
    console.error(
      `⚠️ [CONTAS] Não deu para saber a conta de ${domainName}, usando a principal: ${e.message}`
    );
    return contas.PRINCIPAL;
  }
}

/**
 * Qual conta deve receber a PRÓXIMA compra.
 *
 * Lê o placar no banco e entrega a decisão para `contas.escolher()`, que é
 * pura e tem as provas.
 *
 * ── UMA CONTAGEM POR CONTA, E NÃO UM SELECT ──────────────────────────────
 *
 * `count: 'exact', head: true` por conta, em vez de trazer as linhas e
 * contar aqui. Não é preciosismo: o PostgREST corta em MIL LINHAS EM
 * SILÊNCIO, e este projeto já foi mordido por isso quatro vezes. Passando
 * de mil compras, a contagem no JavaScript travaria em 1.000 e o rodízio
 * passaria a decidir com número errado — sem erro nenhum aparecer.
 *
 * ── SÓ AS COMPRAS DO RODÍZIO ─────────────────────────────────────────────
 *
 * O filtro é `registrar_account = apelido`, que por construção exclui as
 * ~2.705 linhas com `null` — as compradas antes disto existir. Ver a
 * migration: carimbá-las mandaria as próximas ~1.350 compras seguidas para
 * a conta nova, compensando um passado que não é para compensar.
 *
 * ── `excluir`: CONTAS QUE JA FALHARAM NESTA SESSAO ───────────────────────
 *
 * Conta sem saldo ou com chave revogada falha SEMPRE. Como a compra que
 * falha não grava linha, o placar dela não sobe — e ela seria escolhida de
 * novo a cada tentativa, gastando as 10 do domínio numa conta quebrada.
 *
 * Quem chama acumula os apelidos que falharam e passa aqui.
 *
 * ── FALHA CAI NA PRINCIPAL ───────────────────────────────────────────────
 *
 * Se o banco não responder, compra na principal em vez de não comprar. O
 * rodízio é uma preferência de distribuição; a compra é o trabalho. Perder
 * a proporção de uma compra é barato, e a razão dela se corrige sozinha na
 * próxima — perder a compra, não.
 */
async function escolherContaParaCompra(excluir = []) {
  if (!contas.temRodizio()) return contas.PRINCIPAL;

  try {
    const placar = {};

    for (const c of contas.listar()) {
      const { count, error } = await banco()
        .from('domains')
        .select('id', { count: 'exact', head: true })
        .eq('registrar_account', c.apelido);

      if (error) throw new Error(error.message);
      placar[c.apelido] = count ?? 0;
    }

    const escolhida = contas.escolher(placar, excluir);
    console.log(
      `🎲 [CONTAS] Placar ${JSON.stringify(placar)}` +
        (excluir.length ? ` · fora: ${excluir.join(', ')}` : '') +
        ` → próxima compra na conta "${escolhida}"`
    );
    return escolhida;
  } catch (e) {
    console.error(
      `⚠️ [CONTAS] Não deu para ler o placar do rodízio, comprando na principal: ${e.message}`
    );
    return contas.PRINCIPAL;
  }
}

module.exports = { contaDoDominio, escolherContaParaCompra };
