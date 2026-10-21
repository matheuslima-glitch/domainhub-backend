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

module.exports = { contaDoDominio };
