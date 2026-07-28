/**
 * SWAP DE DOMÍNIO — FASE 2: ORQUESTRAÇÃO
 * ----------------------------------------------------------------------------
 * Roda depois que o usuário escolhe, no 2º popup, qual domínio do WHM será
 * substituído pelo domínio recém-comprado.
 *
 * Ordem:
 *   1. modifyacct no WHM (a conta inteira passa a responder pelo domínio novo)
 *   2. banco do WordPress reapontado (siteurl/home + páginas + mídias + Elementor)
 *   3. cache limpo
 *   4. AutoSSL
 *   5. logs de substituição (domínio antigo + domínio novo)
 *   6. desativação do domínio antigo (Cloudflare + Supabase, SEM tocar no WHM)
 *   7. notificação WhatsApp + step `completed` (100%)
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

const { swapDomainOnWHM } = require('./whm-swap');
const { deactivateOldDomainAfterSwap, registerSwapLogs } = require('./swap-deactivation');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

/**
 * Progresso do swap — mesma tabela/mesmo padrão da compra normal.
 */
async function updateProgress(sessionId, step, status, message, domainName = null) {
  try {
    await supabase.from('domain_purchase_progress').upsert({
      session_id: sessionId,
      step,
      status,
      message,
      domain_name: domainName,
      updated_at: new Date().toISOString()
    }, { onConflict: 'session_id' });

    console.log(`📊 [SWAP-PROGRESS] ${step} - ${status} - ${message}`);
  } catch (e) {
    console.error('❌ [SWAP-PROGRESS] Erro:', e.message);
  }
}

/**
 * Notificação de WhatsApp específica do swap (mesmo Z-API do resto do sistema).
 */
async function sendSwapWhatsApp({ oldDomain, newDomain, status, errorMsg = '' }) {
  if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
    console.log('⚠️ [WHATSAPP-SWAP] ZAPI não configurado');
    return;
  }

  try {
    const agora = new Date();
    const dataFormatada = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(agora);
    const horaFormatada = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(agora);

    const message = status === 'success'
      ? `🤖 *Domain Hub*\n\n` +
        `Lerricke, um domínio foi substituído 🔁:\n\n` +
        `🌐Domínio antigo: ${oldDomain}\n` +
        `✅Domínio novo: ${newDomain}\n` +
        `🛜 Plataforma : Wordpress\n` +
        `🗓️Data: ${dataFormatada} ás ${horaFormatada}`
      : `🤖 *Domain Hub*\n\n` +
        `Lerricke, houve um erro ao substituir o domínio ❌:\n\n` +
        `🌐Domínio antigo: ${oldDomain}\n` +
        `🌐Domínio novo: ${newDomain}\n` +
        `❌Erro: ${errorMsg}\n` +
        `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;

    await axios.post(
      config.ZAPI_INSTANCE,
      { phone: String(config.WHATSAPP_PHONE_NUMBER || '').replace(/\D/g, ''), message },
      {
        timeout: 10000,
        headers: { 'Client-Token': config.ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' }
      }
    );

    console.log('✅ [WHATSAPP-SWAP] Notificação enviada');
  } catch (e) {
    console.error('❌ [WHATSAPP-SWAP] Erro ao enviar:', e.message);
  }
}

/**
 * Executa a fase 2 inteira.
 *
 * @param {Object} p
 * @param {string} p.sessionId
 * @param {string} p.oldDomain  domínio que existe hoje no WHM
 * @param {string} p.newDomain  domínio comprado na fase 1
 * @param {string} p.userId     usuário logado (para o log)
 * @param {string} p.userName   nome do usuário logado (para o log)
 */
async function runSwapPhase2({ sessionId, oldDomain, newDomain, userId, userName }) {
  const old = String(oldDomain || '').trim().toLowerCase();
  const nue = String(newDomain || '').trim().toLowerCase();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔁 [SWAP][FASE-2] ${old} → ${nue}`);
  console.log(`   Session: ${sessionId}`);
  console.log(`   Usuário: ${userName || userId || '-'}`);
  console.log(`${'='.repeat(70)}`);

  try {
    // ═══ 1 a 4: WHM + WordPress + cache + SSL
    const swap = await swapDomainOnWHM({
      oldDomain: old,
      newDomain: nue,
      sessionId,
      updateProgress
    });

    if (!swap.success) {
      await updateProgress(sessionId, 'error', 'error',
        `Erro no swap: ${swap.error}`, nue);
      await sendSwapWhatsApp({ oldDomain: old, newDomain: nue, status: 'error', errorMsg: swap.error });
      return { success: false, error: swap.error };
    }

    // ═══ 5: LOGS DE SUBSTITUIÇÃO
    // Domínio novo fica com 2 logs: o de compra (fase 1) + este de substituição.
    await registerSwapLogs({ oldDomain: old, newDomain: nue, userId, userName });

    // ═══ 6: DESATIVAÇÃO DO DOMÍNIO ANTIGO
    await deactivateOldDomainAfterSwap({
      oldDomain: old,
      newDomain: nue,
      sessionId,
      updateProgress
    });

    // ═══ 7: FIM
    await sendSwapWhatsApp({ oldDomain: old, newDomain: nue, status: 'success' });
    await updateProgress(sessionId, 'completed', 'completed',
      `Swap concluído! ${old} → ${nue}`, nue);

    console.log(`✅ [SWAP][FASE-2] Concluído: ${old} → ${nue}`);
    return { success: true, ...swap };

  } catch (error) {
    console.error('❌ [SWAP][FASE-2] Erro:', error.message);
    await updateProgress(sessionId, 'error', 'error',
      `Erro no swap: ${error.message}`, nue);
    await sendSwapWhatsApp({ oldDomain: old, newDomain: nue, status: 'error', errorMsg: error.message });
    return { success: false, error: error.message };
  }
}

module.exports = {
  runSwapPhase2,
  updateProgress,
  sendSwapWhatsApp
};
