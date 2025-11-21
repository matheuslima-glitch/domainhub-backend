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

    // Detectar mudança de status e enviar alertas imediatos
    if (previousDomain && previousDomain.status !== domainData.status) {
      const notificationService = require('./whatsapp/notifications');
      
      // Alerta de domínio suspenso
      if (previousDomain.status === 'active' && domainData.status === 'suspended') {
        console.log(`🚨 [ALERT] Domínio mudou de ativo para suspenso: ${domainData.domain_name}`);
        await notificationService.sendSuspendedDomainAlert(config.SUPABASE_USER_ID, domainData.domain_name);
      }
      
      // Alerta de domínio expirado
      if (previousDomain.status === 'active' && domainData.status === 'expired') {
        console.log(`🚨 [ALERT] Domínio mudou de ativo para expirado: ${domainData.domain_name}`);
        await notificationService.sendExpiredDomainAlert(config.SUPABASE_USER_ID, domainData.domain_name);
      }
    }

    return data;
  }

  async updateDomainAlert(domainName, alertData) {
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