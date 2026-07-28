/**
 * DESATIVAÇÃO DO DOMÍNIO ANTIGO DEPOIS DO SWAP
 * ----------------------------------------------------------------------------
 * Segue os MESMOS passos da desativação que já existe no sistema
 * (services/domain-deactivation) — remove a zona da Cloudflare e marca o
 * domínio como `deactivated` no Supabase — MENOS as duas etapas que agora não
 * fazem sentido (e seriam destrutivas):
 *
 *   ❌ Desinstalar o WordPress  → o WordPress É o site que acabou de migrar
 *   ❌ Remover a conta do WHM   → a conta agora pertence ao domínio NOVO;
 *                                 apagá-la destruiria o site inteiro
 *
 * Trava de segurança: a desativação só roda se o domínio antigo REALMENTE não
 * existir mais no WHM. Se ele ainda estiver lá, significa que o modifyacct não
 * concluiu — nesse caso nada é removido e o processo apenas avisa.
 *
 * Nenhum arquivo da desativação existente é modificado: este módulo apenas
 * IMPORTA e reutiliza os métodos do serviço.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const DomainDeactivationService = require('../../services/domain-deactivation');
const { findAccountByDomain } = require('./whm-swap');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

const SWAP_ACTION_TYPE = 'domain_swapped';

/**
 * Busca o registro de um domínio no Supabase pelo nome.
 */
async function getDomainRow(domainName) {
  try {
    const { data, error } = await supabase
      .from('domains')
      .select('id, domain_name, status')
      .eq('domain_name', String(domainName || '').trim().toLowerCase())
      .maybeSingle();

    if (error) {
      console.error(`⚠️ [SWAP-DEACT] Erro ao buscar ${domainName}:`, error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.error(`⚠️ [SWAP-DEACT] Erro ao buscar ${domainName}:`, e.message);
    return null;
  }
}

/**
 * Registra um log de atividade no padrão da aplicação
 * (domain_activity_logs: domain_id, user_id, user_name, action_type,
 *  old_value, new_value).
 */
async function saveSwapLog({ domainId, userId, userName, oldValue, newValue }) {
  if (!domainId) return false;

  try {
    const { error } = await supabase.from('domain_activity_logs').insert({
      domain_id: domainId,
      user_id: userId || null,
      user_name: userName || null,
      action_type: SWAP_ACTION_TYPE,
      old_value: oldValue,
      new_value: newValue,
      created_at: new Date().toISOString()
    });

    if (error) {
      console.error('⚠️ [SWAP-LOG] Erro ao registrar log:', error.message);
      return false;
    }
    console.log(`✅ [SWAP-LOG] Log registrado (${domainId})`);
    return true;
  } catch (e) {
    console.error('⚠️ [SWAP-LOG] Erro ao registrar log:', e.message);
    return false;
  }
}

/**
 * Registra os DOIS logs do swap:
 *   - domínio ANTIGO: "Domínio substituído por {novo}"
 *   - domínio NOVO:   "Substituiu o domínio {antigo}"  (2º log; o 1º é o de compra)
 * O "por quem" fica no user_id / user_name, exatamente como no resto do app.
 */
async function registerSwapLogs({ oldDomain, newDomain, userId, userName }) {
  const oldRow = await getDomainRow(oldDomain);
  const newRow = await getDomainRow(newDomain);

  if (oldRow?.id) {
    await saveSwapLog({
      domainId: oldRow.id,
      userId,
      userName,
      oldValue: `Domínio ativo: ${oldDomain}`,
      newValue: `Domínio substituído por ${newDomain}`
    });
  } else {
    console.log(`⚠️ [SWAP-LOG] Domínio antigo ${oldDomain} não encontrado no Supabase — log não registrado`);
  }

  if (newRow?.id) {
    await saveSwapLog({
      domainId: newRow.id,
      userId,
      userName,
      oldValue: `Domínio anterior: ${oldDomain}`,
      newValue: `Substituiu o domínio ${oldDomain}`
    });
  }

  return { oldRow, newRow };
}

/**
 * Desativa o domínio antigo depois do swap.
 *
 * @param {Object} p
 * @param {string} p.oldDomain
 * @param {string} p.newDomain
 * @param {string} p.sessionId
 * @param {Function} p.updateProgress  (sessionId, step, status, message, domain)
 */
async function deactivateOldDomainAfterSwap({ oldDomain, newDomain, sessionId, updateProgress }) {
  const up = async (step, status, msg) => {
    if (updateProgress) { try { await updateProgress(sessionId, step, status, msg, newDomain); } catch (_) {} }
  };

  const service = new DomainDeactivationService();
  const result = { cloudflare: null, supabase: null, skipped: false };

  await up('swap_deactivate', 'in_progress', `Desativando o domínio antigo ${oldDomain}...`);

  // ═══ TRAVA DE SEGURANÇA ═══
  // Se o domínio antigo ainda existe no WHM, o swap não concluiu. Não mexe em nada.
  try {
    const stillOnWHM = await findAccountByDomain(oldDomain);
    if (stillOnWHM) {
      result.skipped = true;
      console.log(`🛑 [SWAP-DEACT] ${oldDomain} ainda existe no WHM — desativação abortada por segurança`);
      await up('swap_deactivate', 'error',
        `O domínio ${oldDomain} ainda aparece no WHM. Desativação cancelada por segurança.`);
      return result;
    }
  } catch (e) {
    console.error('⚠️ [SWAP-DEACT] Não foi possível confirmar a remoção no WHM:', e.message);
  }

  // ═══ 1) CLOUDFLARE — mesma lógica da desativação atual
  try {
    const zone = await service.findCloudflareZone(oldDomain);
    if (zone) {
      result.cloudflare = await service.removeCloudflareZone(zone.id, oldDomain);
    } else {
      result.cloudflare = { success: true, message: 'Zona não encontrada no Cloudflare - etapa pulada' };
    }
  } catch (e) {
    result.cloudflare = { success: false, message: e.message };
  }

  // ═══ 2) SUPABASE — status deactivated (mesma função da desativação atual)
  const oldRow = await getDomainRow(oldDomain);
  if (oldRow?.id) {
    result.supabase = await service.deactivateInSupabase(oldRow.id);
  } else {
    result.supabase = { success: false, message: `Domínio ${oldDomain} não encontrado no Supabase` };
  }

  const okCf = result.cloudflare?.success !== false;
  const okDb = result.supabase?.success === true;

  if (okDb) {
    await up('swap_deactivate', 'completed',
      `Domínio antigo ${oldDomain} desativado${okCf ? ' e removido da Cloudflare' : ''}`);
  } else {
    await up('swap_deactivate', 'error',
      `Swap concluído, mas a desativação de ${oldDomain} falhou: ${result.supabase?.message || 'erro desconhecido'}`);
  }

  return result;
}

module.exports = {
  deactivateOldDomainAfterSwap,
  registerSwapLogs,
  getDomainRow,
  saveSwapLog,
  SWAP_ACTION_TYPE
};
