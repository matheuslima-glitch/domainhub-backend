/**
 * ============================================================
 * 
 * FUNÇÕES PRINCIPAIS:
 * 
 * 1. upsertDomain(domainData)
 *    - Insere ou atualiza um domínio no banco
 *    - Detecta mudança de status (active → suspended/expired)
 *    - Envia alertas WhatsApp quando status muda para crítico
 * 
 * 2. updateDomainAlert(domainName, alertData)
 *    - Atualiza domínios com erros/alertas (suspensos, bloqueados)
 *    - Detecta mudança de status e envia alertas WhatsApp
 *    - Usado quando API retorna erro de domínio suspenso
 * 
 * 3. isManuallyDeactivated(domainName)
 *    - Verifica se domínio foi desativado manualmente pelo usuário
 *    - Domínios desativados não são atualizados pela sincronização
 * 
 * 4. batchUpsertDomains(domains)
 *    - Processa lote de domínios em massa
 *    - Pula domínios protegidos (desativados manualmente)
 *    - Roteia para upsertDomain ou updateDomainAlert conforme tipo
 * 
 * ============================================================
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

class SupabaseDomainsService {
  constructor() {
    this.client = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  }

  async upsertDomain(domainData) {
    const payload = {
      p_user_id: config.SUPABASE_USER_ID,
      p_domain_name: domainData.domain_name,
      p_expiration_date: domainData.expiration_date,
      p_purchase_date: domainData.purchase_date || null,
      p_status: domainData.status,
      p_registrar: domainData.registrar,
      p_integration_source: domainData.integration_source,
      p_last_stats_update: domainData.last_stats_update,
      p_nameservers: domainData.nameservers,
      p_dns_configured: domainData.dns_configured,
      p_auto_renew: domainData.auto_renew
    };

    // Verificar status anterior do domínio antes de atualizar
    const { data: previousDomain } = await this.client
      .from('domains')
      .select('status')
      .eq('domain_name', domainData.domain_name)
      .eq('user_id', config.SUPABASE_USER_ID)
      .maybeSingle();

    const { data, error } = await this.client.rpc('upsert_domain_stats', payload);

    if (error) throw error;

    // ═══════════════════════════════════════════════════════════════
    // LIMPAR ALERTA RESOLVIDO
    //
    // A RPC upsert_domain_stats não recebe has_alert, então um alerta gravado uma
    // única vez sobrevivia para sempre — inclusive falhas transitórias da API da
    // Namecheap ("Ocorreu uma exceção não tratada"), que ficavam coladas em
    // domínios perfeitamente saudáveis.
    //
    // Isso tinha efeito colateral grave: no popup de cópia o rótulo "Alerta"
    // ganhava de "Crítico/Expirando", e o domínio sumia da lista de renovação.
    //
    // Chegar aqui significa que a sincronização leu o domínio SEM erro.
    // É seguro limpar: se o problema persistir, o próximo ciclo (4h) regrava o
    // alerta via updateDomainAlert. Nenhum alerta real se perde.
    // ═══════════════════════════════════════════════════════════════
    try {
      const { data: cleared, error: clearError } = await this.client
        .from('domains')
        .update({ has_alert: null })
        .eq('domain_name', domainData.domain_name)
        .eq('user_id', config.SUPABASE_USER_ID)
        .not('has_alert', 'is', null)
        .select('domain_name');

      if (clearError) {
        console.warn(`⚠️ Não foi possível limpar has_alert de ${domainData.domain_name}: ${clearError.message}`);
      } else if (cleared && cleared.length > 0) {
        console.log(`🧹 Alerta resolvido removido: ${domainData.domain_name}`);
      }
    } catch (clearErr) {
      // Falha aqui não invalida o upsert que já foi gravado com sucesso
      console.warn(`⚠️ Falha ao limpar has_alert de ${domainData.domain_name}: ${clearErr.message}`);
    }

    // Detectar mudança de status e enviar alertas imediatos
    if (previousDomain && previousDomain.status !== domainData.status) {
      const notificationService = require('../whatsapp/notifications');
      
      console.log(`📊 [STATUS] Mudança detectada: ${domainData.domain_name}`);
      console.log(`📊 [STATUS] De: ${previousDomain.status} → Para: ${domainData.status}`);
      
      // Alerta de domínio suspenso (qualquer status anterior → suspenso)
      if (domainData.status === 'suspended' && previousDomain.status !== 'suspended') {
        console.log(`🚨 [ALERT] Domínio ficou suspenso: ${domainData.domain_name}`);
        await notificationService.sendSuspendedDomainAlert(config.SUPABASE_USER_ID, domainData.domain_name);
      }
      
      // Alerta de domínio expirado (qualquer status anterior → expirado)
      if (domainData.status === 'expired' && previousDomain.status !== 'expired') {
        console.log(`🚨 [ALERT] Domínio ficou expirado: ${domainData.domain_name}`);
        await notificationService.sendExpiredDomainAlert(config.SUPABASE_USER_ID, domainData.domain_name);
      }
    }
    
    // Alertar também para domínios novos que já chegam com status crítico
    if (!previousDomain && (domainData.status === 'suspended' || domainData.status === 'expired')) {
      const notificationService = require('../whatsapp/notifications');
      
      console.log(`🆕 [ALERT] Novo domínio com status crítico: ${domainData.domain_name} (${domainData.status})`);
      
      if (domainData.status === 'suspended') {
        await notificationService.sendSuspendedDomainAlert(config.SUPABASE_USER_ID, domainData.domain_name);
      } else if (domainData.status === 'expired') {
        await notificationService.sendExpiredDomainAlert(config.SUPABASE_USER_ID, domainData.domain_name);
      }
    }

    return data;
  }

  async updateDomainAlert(domainName, alertData) {
    // Verificar status anterior do domínio antes de atualizar
    const { data: previousDomain } = await this.client
      .from('domains')
      .select('status')
      .eq('domain_name', domainName)
      .eq('user_id', config.SUPABASE_USER_ID)
      .maybeSingle();

    const { data, error } = await this.client
      .from('domains')
      .update({
        status: alertData.status,
        has_alert: alertData.has_alert,
        last_stats_update: alertData.last_stats_update,
        updated_at: new Date().toISOString()
      })
      .eq('domain_name', domainName)
      .eq('user_id', config.SUPABASE_USER_ID)
      .select();

    if (error) throw error;

    // Detectar mudança de status e enviar alertas imediatos
    const previousStatus = previousDomain?.status;
    const newStatus = alertData.status;
    
    if (previousStatus && previousStatus !== newStatus) {
      const notificationService = require('../whatsapp/notifications');
      
      console.log(`📊 [STATUS-ALERT] Mudança detectada: ${domainName}`);
      console.log(`📊 [STATUS-ALERT] De: ${previousStatus} → Para: ${newStatus}`);
      
      // Alerta de domínio suspenso (qualquer status anterior → suspenso)
      if (newStatus === 'suspended' && previousStatus !== 'suspended') {
        console.log(`🚨 [ALERT] Domínio ficou suspenso: ${domainName}`);
        await notificationService.sendSuspendedDomainAlert(config.SUPABASE_USER_ID, domainName);
      }
      
      // Alerta de domínio expirado (qualquer status anterior → expirado)
      if (newStatus === 'expired' && previousStatus !== 'expired') {
        console.log(`🚨 [ALERT] Domínio ficou expirado: ${domainName}`);
        await notificationService.sendExpiredDomainAlert(config.SUPABASE_USER_ID, domainName);
      }
    }
    
    // Alertar também se não tinha registro anterior (domínio novo com status crítico)
    if (!previousDomain && (newStatus === 'suspended' || newStatus === 'expired')) {
      const notificationService = require('../whatsapp/notifications');
      
      console.log(`🆕 [ALERT] Novo domínio com status crítico: ${domainName} (${newStatus})`);
      
      if (newStatus === 'suspended') {
        await notificationService.sendSuspendedDomainAlert(config.SUPABASE_USER_ID, domainName);
      } else if (newStatus === 'expired') {
        await notificationService.sendExpiredDomainAlert(config.SUPABASE_USER_ID, domainName);
      }
    }

    return data;
  }

  /**
   * Verifica se um domínio foi desativado manualmente pelo usuário
   * @param {string} domainName - Nome do domínio
   * @returns {Promise<boolean>} - true se foi desativado manualmente
   */
  async isManuallyDeactivated(domainName) {
    try {
      const { data, error } = await this.client
        .from('domains')
        .select('manually_deactivated, status')
        .eq('domain_name', domainName)
        .eq('user_id', config.SUPABASE_USER_ID)
        .single();

      if (error) {
        // Se o domínio não existir ainda, retorna false
        if (error.code === 'PGRST116') return false;
        throw error;
      }

      // Retorna true se manually_deactivated for true OU se status for deactivated
      return data?.manually_deactivated === true || data?.status === 'deactivated';
    } catch (error) {
      console.error(`⚠️ Erro ao verificar flag manually_deactivated para ${domainName}:`, error.message);
      return false; // Em caso de erro, permite a atualização
    }
  }

  async batchUpsertDomains(domains) {
    const results = {
      success: 0,
      failed: 0,
      skipped: 0, // Novo contador para domínios pulados
      errors: []
    };

    for (const domain of domains) {
      try {
        // ═══════════════════════════════════════════════════════════════
        // VERIFICAÇÃO: Domínio desativado manualmente?
        // ═══════════════════════════════════════════════════════════════
        const isProtected = await this.isManuallyDeactivated(domain.domain_name);
        
        if (isProtected) {
          console.log(`🔒 DOMÍNIO PROTEGIDO (Desativado manualmente): ${domain.domain_name}`);
          console.log(`   ⏭️ PULANDO atualização - flag manually_deactivated = TRUE`);
          results.skipped++;
          continue; // Pula este domínio
        }

        // ═══════════════════════════════════════════════════════════════
        // ATUALIZAÇÃO NORMAL: Domínio não está protegido
        // ═══════════════════════════════════════════════════════════════
        if (domain.has_error && domain.has_alert) {
          await this.updateDomainAlert(domain.domain_name, {
            status: domain.status,
            has_alert: domain.has_alert,
            last_stats_update: domain.last_stats_update
          });
          console.log(`✅ Alerta salvo: ${domain.domain_name}`);
        } else {
          await this.upsertDomain(domain);
          console.log(`✅ Domínio atualizado: ${domain.domain_name}`);
        }
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          domain: domain.domain_name,
          error: error.message
        });
        console.error(`❌ Erro ao salvar ${domain.domain_name}:`, error.message);
      }
    }

    // Log de resumo
    if (results.skipped > 0) {
      console.log(`\n🔒 Total de domínios PROTEGIDOS (pulados): ${results.skipped}`);
    }

    return results;
  }
}

module.exports = new SupabaseDomainsService();