/**
 * SERVIÇO DE DESATIVAÇÃO COMPLETA DE DOMÍNIOS
 * 
 * Este serviço gerencia a desativação completa de domínios, incluindo:
 * 1. Desinstalação do WordPress via Softaculous
 * 2. Remoção do domínio do cPanel
 * 3. Remoção da zona do Cloudflare
 * 4. Atualização do status no Supabase
 * 
 * O serviço detecta automaticamente quais integrações existem para cada domínio.
 */

const axios = require('axios');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');

// Inicializar Supabase
const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_KEY
);

class DomainDeactivationService {
  constructor() {
    this.cloudflareAPI = 'https://api.cloudflare.com/client/v4';
    this.softaculousPath = '/frontend/jupiter/softaculous/index.live.php';
  }

  /**
   * DETECTAR INTEGRAÇÕES DO DOMÍNIO
   * Verifica quais serviços estão configurados para o domínio
   */
  async detectIntegrations(domainName) {
    console.log(`\n🔍 [DETECT] Detectando integrações para ${domainName}...`);
    
    const integrations = {
      wordpress: { exists: false, insid: null, details: null },
      cpanel: { exists: false, subdomain: null },
      cloudflare: { exists: false, zoneId: null }
    };

    // 1. Verificar WordPress no Softaculous
    try {
      const wpInstallation = await this.findWordPressInstallation(domainName);
      if (wpInstallation) {
        integrations.wordpress.exists = true;
        integrations.wordpress.insid = wpInstallation.insid;
        integrations.wordpress.details = wpInstallation;
        console.log(`   ✅ WordPress encontrado: insid=${wpInstallation.insid}`);
      } else {
        console.log(`   ⚪ WordPress não encontrado`);
      }
    } catch (error) {
      console.log(`   ⚠️ Erro ao verificar WordPress: ${error.message}`);
    }

    // 2. Verificar domínio no cPanel
    try {
      const cpanelDomain = await this.findCPanelDomain(domainName);
      if (cpanelDomain) {
        integrations.cpanel.exists = true;
        integrations.cpanel.subdomain = cpanelDomain.subdomain;
        integrations.cpanel.details = cpanelDomain;
        console.log(`   ✅ cPanel encontrado: subdomain=${cpanelDomain.subdomain}`);
      } else {
        console.log(`   ⚪ cPanel não encontrado`);
      }
    } catch (error) {
      console.log(`   ⚠️ Erro ao verificar cPanel: ${error.message}`);
    }

    // 3. Verificar zona no Cloudflare
    try {
      const cloudflareZone = await this.findCloudflareZone(domainName);
      if (cloudflareZone) {
        integrations.cloudflare.exists = true;
        integrations.cloudflare.zoneId = cloudflareZone.id;
        integrations.cloudflare.details = cloudflareZone;
        console.log(`   ✅ Cloudflare encontrado: zoneId=${cloudflareZone.id}`);
      } else {
        console.log(`   ⚪ Cloudflare não encontrado`);
      }
    } catch (error) {
      console.log(`   ⚠️ Erro ao verificar Cloudflare: ${error.message}`);
    }

    console.log(`\n📊 [DETECT] Resumo de integrações:`);
    console.log(`   WordPress: ${integrations.wordpress.exists ? '✅' : '⚪'}`);
    console.log(`   cPanel: ${integrations.cpanel.exists ? '✅' : '⚪'}`);
    console.log(`   Cloudflare: ${integrations.cloudflare.exists ? '✅' : '⚪'}`);

    return integrations;
  }

  /**
   * BUSCAR INSTALAÇÃO WORDPRESS NO SOFTACULOUS
   */
  async findWordPressInstallation(domainName) {
    try {
      const response = await axios.get(
        `${config.CPANEL_URL}${this.softaculousPath}?act=installations&soft=26&api=json`,
        {
          auth: {
            username: config.CPANEL_USERNAME,
            password: config.CPANEL_PASSWORD
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const installations = response.data?.installations?.['26'] || {};
      
      // Procurar pelo domínio
      for (const [insid, installation] of Object.entries(installations)) {
        if (installation.softdomain === domainName) {
          return { ...installation, insid };
        }
      }

      return null;
    } catch (error) {
      console.error(`❌ [SOFTACULOUS] Erro ao buscar instalações:`, error.message);
      return null;
    }
  }

  /**
   * BUSCAR DOMÍNIO NO CPANEL
   */
  async findCPanelDomain(domainName) {
    try {
      const response = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=listaddondomains`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const domains = response.data?.cpanelresult?.data || [];
      
      // Procurar pelo domínio
      for (const domain of domains) {
        if (domain.domain === domainName) {
          return domain;
        }
      }

      return null;
    } catch (error) {
      console.error(`❌ [CPANEL] Erro ao buscar domínios:`, error.message);
      return null;
    }
  }

  /**
   * BUSCAR ZONA NO CLOUDFLARE
   */
  async findCloudflareZone(domainName) {
    if (!config.CLOUDFLARE_EMAIL || !config.CLOUDFLARE_API_KEY) {
      return null;
    }

    try {
      const response = await axios.get(
        `${this.cloudflareAPI}/zones?name=${domainName}`,
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const zones = response.data?.result || [];
      return zones.length > 0 ? zones[0] : null;
    } catch (error) {
      console.error(`❌ [CLOUDFLARE] Erro ao buscar zona:`, error.message);
      return null;
    }
  }

  /**
   * DESINSTALAR WORDPRESS VIA SOFTACULOUS
   */
  async uninstallWordPress(insid) {
    console.log(`\n🗑️ [WORDPRESS] Desinstalando WordPress (insid: ${insid})...`);

    try {
      const response = await axios.post(
        `${config.CPANEL_URL}${this.softaculousPath}?act=remove&insid=${insid}&api=json`,
        'removeins=1&remove_dir=1&remove_db=1',
        {
          auth: {
            username: config.CPANEL_USERNAME,
            password: config.CPANEL_PASSWORD
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 60000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      if (response.data?.done === true) {
        console.log(`   ✅ WordPress desinstalado com sucesso!`);
        return { success: true, message: 'WordPress desinstalado com sucesso' };
      } else {
        console.log(`   ⚠️ Resposta inesperada:`, JSON.stringify(response.data));
        return { success: false, message: 'Resposta inesperada do Softaculous' };
      }
    } catch (error) {
      console.error(`   ❌ Erro ao desinstalar WordPress:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * REMOVER DOMÍNIO DO CPANEL (Addon Domain)
   * Todos os domínios são Addon Domains com subdomínio no padrão: {dominio}.institutoexperience.com.br
   */
  async removeCPanelDomain(domainName) {
    console.log(`\n🗑️ [CPANEL] Removendo Addon Domain ${domainName}...`);

    try {
      // Gerar o subdomain no padrão usado: dominio.tld -> dominio.tld.institutoexperience.com.br
      const subdomain = `${domainName}.institutoexperience.com.br`;
      console.log(`   📌 Subdomain calculado: ${subdomain}`);

      const response = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=deladdondomain&domain=${domainName}&subdomain=${subdomain}`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      console.log(`   📋 Resposta cPanel:`, JSON.stringify(response.data, null, 2));

      const result = response.data?.cpanelresult?.data?.[0];
      
      if (result?.result === 1) {
        console.log(`   ✅ Addon Domain removido com sucesso!`);
        return { success: true, message: result.reason || 'Addon Domain removido com sucesso' };
      } else {
        console.log(`   ⚠️ Falha ao remover:`, result?.reason);
        return { success: false, message: result?.reason || 'Falha ao remover domínio' };
      }
    } catch (error) {
      console.error(`   ❌ Erro ao remover domínio do cPanel:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * REMOVER ZONA DO CLOUDFLARE
   */
  async removeCloudflareZone(zoneId, domainName) {
    console.log(`\n🗑️ [CLOUDFLARE] Removendo zona ${domainName} (${zoneId})...`);

    if (!config.CLOUDFLARE_EMAIL || !config.CLOUDFLARE_API_KEY) {
      console.log(`   ⚠️ Cloudflare não configurado`);
      return { success: false, message: 'Cloudflare não configurado' };
    }

    try {
      const response = await axios.delete(
        `${this.cloudflareAPI}/zones/${zoneId}`,
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data?.success) {
        console.log(`   ✅ Zona Cloudflare removida com sucesso!`);
        return { success: true, message: 'Zona Cloudflare removida com sucesso' };
      } else {
        console.log(`   ⚠️ Falha ao remover zona:`, response.data?.errors);
        return { success: false, message: response.data?.errors?.[0]?.message || 'Falha ao remover zona' };
      }
    } catch (error) {
      console.error(`   ❌ Erro ao remover zona Cloudflare:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * DESATIVAR DOMÍNIO NO SUPABASE
   */
  async deactivateInSupabase(domainId) {
    console.log(`\n💾 [SUPABASE] Desativando domínio no banco de dados...`);

    try {
      const { error } = await supabase
        .from('domains')
        .update({
          status: 'deactivated',
          manually_deactivated: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', domainId);

      if (error) {
        console.error(`   ❌ Erro ao atualizar Supabase:`, error.message);
        return { success: false, message: error.message };
      }

      console.log(`   ✅ Domínio desativado no Supabase!`);
      return { success: true, message: 'Domínio desativado no banco de dados' };
    } catch (error) {
      console.error(`   ❌ Erro ao desativar no Supabase:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * PROCESSO COMPLETO DE DESATIVAÇÃO
   * Executa todas as etapas necessárias baseado nas integrações detectadas
   */
  async deactivateDomain(domainId, domainName) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚨 [DEACTIVATION] INICIANDO DESATIVAÇÃO COMPLETA`);
    console.log(`   Domain ID: ${domainId}`);
    console.log(`   Domain Name: ${domainName}`);
    console.log(`${'='.repeat(70)}`);

    const results = {
      domainId,
      domainName,
      integrations: null,
      steps: {
        wordpress: { executed: false, success: false, message: null },
        cpanel: { executed: false, success: false, message: null },
        cloudflare: { executed: false, success: false, message: null },
        supabase: { executed: false, success: false, message: null }
      },
      overallSuccess: false,
      completedAt: null
    };

    try {
      // ETAPA 1: Detectar integrações
      const integrations = await this.detectIntegrations(domainName);
      results.integrations = integrations;

      // ETAPA 2: Desinstalar WordPress (se existir)
      if (integrations.wordpress.exists) {
        results.steps.wordpress.executed = true;
        const wpResult = await this.uninstallWordPress(integrations.wordpress.insid);
        results.steps.wordpress.success = wpResult.success;
        results.steps.wordpress.message = wpResult.message;
        
        // Aguardar um pouco após desinstalar WordPress
        if (wpResult.success) {
          await this.delay(2000);
        }
      } else {
        results.steps.wordpress.message = 'WordPress não encontrado - etapa pulada';
      }

      // ETAPA 3: Remover do cPanel (se existir)
      if (integrations.cpanel.exists) {
        results.steps.cpanel.executed = true;
        const cpanelResult = await this.removeCPanelDomain(domainName);
        results.steps.cpanel.success = cpanelResult.success;
        results.steps.cpanel.message = cpanelResult.message;
      } else {
        results.steps.cpanel.message = 'Domínio não encontrado no cPanel - etapa pulada';
      }

      // ETAPA 4: Remover zona do Cloudflare (se existir)
      if (integrations.cloudflare.exists) {
        results.steps.cloudflare.executed = true;
        const cfResult = await this.removeCloudflareZone(
          integrations.cloudflare.zoneId,
          domainName
        );
        results.steps.cloudflare.success = cfResult.success;
        results.steps.cloudflare.message = cfResult.message;
      } else {
        results.steps.cloudflare.message = 'Zona não encontrada no Cloudflare - etapa pulada';
      }

      // ETAPA 5: Desativar no Supabase (sempre executa)
      results.steps.supabase.executed = true;
      const supabaseResult = await this.deactivateInSupabase(domainId);
      results.steps.supabase.success = supabaseResult.success;
      results.steps.supabase.message = supabaseResult.message;

      // Verificar sucesso geral
      results.overallSuccess = results.steps.supabase.success;
      results.completedAt = new Date().toISOString();

      // Log final
      console.log(`\n${'='.repeat(70)}`);
      console.log(`📊 [DEACTIVATION] RESUMO DA DESATIVAÇÃO`);
      console.log(`${'='.repeat(70)}`);
      console.log(`   WordPress: ${results.steps.wordpress.executed ? (results.steps.wordpress.success ? '✅' : '❌') : '⏭️'} ${results.steps.wordpress.message || ''}`);
      console.log(`   cPanel: ${results.steps.cpanel.executed ? (results.steps.cpanel.success ? '✅' : '❌') : '⏭️'} ${results.steps.cpanel.message || ''}`);
      console.log(`   Cloudflare: ${results.steps.cloudflare.executed ? (results.steps.cloudflare.success ? '✅' : '❌') : '⏭️'} ${results.steps.cloudflare.message || ''}`);
      console.log(`   Supabase: ${results.steps.supabase.executed ? (results.steps.supabase.success ? '✅' : '❌') : '⏭️'} ${results.steps.supabase.message || ''}`);
      console.log(`\n   Status Geral: ${results.overallSuccess ? '✅ SUCESSO' : '⚠️ PARCIAL/FALHA'}`);
      console.log(`${'='.repeat(70)}\n`);

      return results;

    } catch (error) {
      console.error(`\n❌ [DEACTIVATION] ERRO CRÍTICO:`, error.message);
      results.error = error.message;
      return results;
    }
  }

  /**
   * HELPER: Delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = DomainDeactivationService;