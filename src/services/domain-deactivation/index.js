/**
 * SERVIÇO DE DESATIVAÇÃO COMPLETA DE DOMÍNIOS - V6
 * 
 * CORREÇÃO V6: Domínios adicionados manualmente no cPanel criam subdomínios
 * com formato diferente. Este código tenta ambos os formatos:
 * 
 * - Formato padrão (API/automático): vitalityjourney.institutoexperience.com.br
 * - Formato manual (cPanel interface): vitalityjourney.online_institutoexperience.com.br
 * 
 * Fluxo de remoção:
 * 1. Detecta integrações (WordPress, cPanel, Cloudflare)
 * 2. Desinstala WordPress via Softaculous
 * 3. Remove domínio do cPanel (tentando múltiplos métodos e formatos)
 * 4. Remove zona do Cloudflare
 * 5. Atualiza status no Supabase
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
   * REMOVER DOMÍNIO DO CPANEL - V6
   * 
   * CORREÇÃO PRINCIPAL: Quando domínio é adicionado manualmente pelo cPanel,
   * o subdomain é criado com formato diferente:
   * 
   * - Automático: vitalityjourney.institutoexperience.com.br
   * - Manual: vitalityjourney.online_institutoexperience.com.br
   * 
   * Este método tenta ambos os formatos.
   */
  async removeCPanelDomain(domainName) {
    console.log(`\n🗑️ [CPANEL] Removendo domínio ${domainName}...`);

    // Gerar DOIS formatos de subdomain possíveis
    const subdomainStandard = `${domainName}.institutoexperience.com.br`;  // Formato padrão (API)
    const subdomainManual = `${domainName}_institutoexperience.com.br`;    // Formato manual (cPanel interface)
    
    console.log(`   📌 Formato padrão (API): ${subdomainStandard}`);
    console.log(`   📌 Formato manual (cPanel): ${subdomainManual}`);

    // ========================================
    // MÉTODO 1: Tentar remover como Addon Domain (formato MANUAL primeiro)
    // ========================================
    console.log(`\n   🔄 MÉTODO 1: Tentando Addon Domain (formato manual)...`);
    try {
      const addonManualResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=deladdondomain&domain=${domainName}&subdomain=${subdomainManual}`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const addonManualResult = addonManualResponse.data?.cpanelresult?.data?.[0];
      
      if (addonManualResult?.result === 1) {
        console.log(`   ✅ Addon Domain removido (formato manual)!`);
        return { success: true, message: 'Domínio removido do cPanel com sucesso' };
      } else {
        console.log(`   ⚠️ Formato manual falhou: ${addonManualResult?.reason}`);
      }
    } catch (addonManualError) {
      console.log(`   ⚠️ Erro no formato manual: ${addonManualError.message}`);
    }

    // ========================================
    // MÉTODO 2: Tentar remover como Addon Domain (formato PADRÃO)
    // ========================================
    console.log(`\n   🔄 MÉTODO 2: Tentando Addon Domain (formato padrão)...`);
    try {
      const addonStandardResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=deladdondomain&domain=${domainName}&subdomain=${subdomainStandard}`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const addonStandardResult = addonStandardResponse.data?.cpanelresult?.data?.[0];
      
      if (addonStandardResult?.result === 1) {
        console.log(`   ✅ Addon Domain removido (formato padrão)!`);
        return { success: true, message: 'Domínio removido do cPanel com sucesso' };
      } else {
        console.log(`   ⚠️ Formato padrão falhou: ${addonStandardResult?.reason}`);
      }
    } catch (addonStandardError) {
      console.log(`   ⚠️ Erro no formato padrão: ${addonStandardError.message}`);
    }

    // ========================================
    // MÉTODO 3: Listar SubDomains e encontrar o formato correto
    // ========================================
    console.log(`\n   🔄 MÉTODO 3: Listando SubDomains para encontrar formato correto...`);
    try {
      const listSubResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=SubDomain&cpanel_jsonapi_func=listsubdomains`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const subdomains = listSubResponse.data?.cpanelresult?.data || [];
      console.log(`   📋 Total de SubDomains: ${subdomains.length}`);

      // Procurar subdomínios relacionados ao domínio
      const relatedSubdomains = subdomains.filter(sd => 
        sd.subdomain?.includes(domainName.replace('.online', '').replace('.com', '').replace('.site', ''))
      );

      console.log(`   🔍 SubDomains relacionados a ${domainName}:`);
      for (const sd of relatedSubdomains) {
        console.log(`      - subdomain: ${sd.subdomain}`);
        console.log(`        domain: ${sd.domain}`);
        console.log(`        dir: ${sd.dir}`);
      }

      // Tentar remover cada subdomínio relacionado
      for (const sd of relatedSubdomains) {
        console.log(`\n   🗑️ Tentando remover subdomínio: ${sd.domain}...`);
        
        try {
          // Primeiro, tentar remover como Addon Domain usando o subdomain encontrado
          const addonFoundResponse = await axios.get(
            `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=deladdondomain&domain=${domainName}&subdomain=${sd.domain}`,
            {
              headers: {
                'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
              },
              timeout: 30000,
              httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
          );

          const addonFoundResult = addonFoundResponse.data?.cpanelresult?.data?.[0];
          
          if (addonFoundResult?.result === 1) {
            console.log(`   ✅ Addon Domain removido usando subdomain: ${sd.domain}!`);
            return { success: true, message: 'Domínio removido do cPanel com sucesso' };
          } else {
            console.log(`   ⚠️ Falhou: ${addonFoundResult?.reason}`);
          }
        } catch (e) {
          console.log(`   ⚠️ Erro: ${e.message}`);
        }

        await this.delay(500);
      }

    } catch (listError) {
      console.log(`   ⚠️ Erro ao listar SubDomains: ${listError.message}`);
    }

    // ========================================
    // MÉTODO 4: Tentar remover como Parked Domain
    // ========================================
    console.log(`\n   🔄 MÉTODO 4: Tentando remover como Parked Domain...`);
    try {
      const unparkResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Park&cpanel_jsonapi_func=unpark&domain=${domainName}`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const unparkResult = unparkResponse.data?.cpanelresult?.data?.[0];
      
      if (unparkResult?.result === 1) {
        console.log(`   ✅ Domínio removido como Parked Domain!`);
        return { success: true, message: 'Domínio removido do cPanel com sucesso' };
      } else {
        console.log(`   ⚠️ Parked Domain falhou: ${unparkResult?.reason}`);
      }
    } catch (unparkError) {
      console.log(`   ⚠️ Erro no Parked Domain: ${unparkError.message}`);
    }

    // ========================================
    // MÉTODO 5: Tentar SubDomain direto (ambos formatos)
    // ========================================
    console.log(`\n   🔄 MÉTODO 5: Tentando remover SubDomain diretamente...`);
    
    // Tentar formato manual primeiro
    const subdomainFormats = [
      `${domainName}.institutoexperience.com.br`,    // formato com ponto
      `${domainName}_institutoexperience.com.br`,    // formato com underscore
    ];

    for (const subFormat of subdomainFormats) {
      try {
        console.log(`   🔄 Tentando SubDomain: ${subFormat}...`);
        
        const subResponse = await axios.get(
          `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=SubDomain&cpanel_jsonapi_func=delsubdomain&domain=${subFormat}`,
          {
            headers: {
              'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
            },
            timeout: 30000,
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
          }
        );

        const subResult = subResponse.data?.cpanelresult?.data?.[0];
        
        if (subResult?.result === 1) {
          console.log(`   ✅ SubDomain removido: ${subFormat}!`);
          return { success: true, message: 'Domínio removido do cPanel com sucesso' };
        } else {
          console.log(`   ⚠️ SubDomain falhou: ${subResult?.reason}`);
        }
      } catch (subError) {
        console.log(`   ⚠️ Erro: ${subError.message}`);
      }
      
      await this.delay(500);
    }

    // Se chegou aqui, todos os métodos falharam
    console.log(`\n   ❌ Todos os métodos de remoção falharam`);
    
    const errorMessage = 'Não foi possível remover o domínio do cPanel. Verifique manualmente no painel.';
    const translatedError = await this.translateCPanelError(errorMessage);
    
    return { success: false, message: translatedError };
  }

  /**
   * TRADUZIR ERROS DO CPANEL PARA PORTUGUÊS USANDO OPENAI
   */
  async translateCPanelError(errorMessage) {
    if (!errorMessage) {
      return errorMessage;
    }
    
    if (!config.OPENAI_API_KEY) {
      console.log(`   ⚠️ OPENAI_API_KEY não configurada, retornando mensagem original`);
      return errorMessage;
    }
    
    console.log(`   🔄 Traduzindo erro do cPanel: "${errorMessage.substring(0, 80)}..."`);
    
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'Você é um tradutor profissional especializado em mensagens técnicas de servidores e hospedagem web.'
            },
            {
              role: 'user',
              content: `Traduza essa mensagem de erro do cPanel para PORTUGUÊS BRASILEIRO:\n\n"${errorMessage}"\n\n- Retorne APENAS o texto traduzido, sem explicações\n- Mantenha termos técnicos como "cPanel", "addon domain", "subdomain" se necessário\n- Use linguagem clara e direta\n- Corrija gramática e acentuação`
            }
          ],
          temperature: 0.3,
          max_tokens: 500
        },
        {
          headers: {
            'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const translated = response.data.choices[0].message.content.trim();
      console.log(`   🌐 Erro traduzido: ${translated}`);
      return translated;
    } catch (error) {
      console.error(`   ❌ Erro ao traduzir mensagem:`, error.response?.data?.error?.message || error.message);
      return errorMessage;
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
   */
  async deactivateDomain(domainId, domainName) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚨 [DEACTIVATION] INICIANDO DESATIVAÇÃO COMPLETA - V6`);
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
      console.log(`📊 [DEACTIVATION] RESUMO DA DESATIVAÇÃO - V6`);
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