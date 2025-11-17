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

    const { data, error } = await this.client.rpc('upsert_domain_stats', payload);

    if (error) throw error;

    if (domainData.has_alert) {
      const { error: alertError } = await this.client
        .from('domains')
        .update({ 
          has_alert: domainData.has_alert,
          updated_at: new Date().toISOString()
        })
        .eq('domain_name', domainData.domain_name)
        .eq('user_id', config.SUPABASE_USER_ID);

      if (alertError) {
        console.error(`⚠️ Erro ao salvar alerta de ${domainData.domain_name}:`, alertError.message);
      }
    }

    return data;
  }

  async batchUpsertDomains(domains) {
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    for (const domain of domains) {
      try {
        await this.upsertDomain(domain);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          domain: domain.domain_name,
          error: error.message
        });
      }
    }

    return results;
  }
}

module.exports = new SupabaseDomainsService();