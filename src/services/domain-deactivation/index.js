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
   * REMOVER DOMÍNIO DO CPANEL
   * Tenta múltiplos métodos de remoção:
   * 1. UAPI DomainInfo (nova interface do cPanel)
   * 2. Addon Domain (método tradicional)
   * 3. Parked Domain (domínio estacionado)
   */
  async removeCPanelDomain(domainName) {
    console.log(`\n🗑️ [CPANEL] Removendo domínio ${domainName}...`);

    // Gerar o subdomain no padrão usado
    const subdomain = `${domainName}.institutoexperience.com.br`;
    console.log(`   📌 Subdomain calculado: ${subdomain}`);

    // MÉTODO 1: Tentar remover usando UAPI (nova API do cPanel)
    console.log(`\n   🔄 MÉTODO 1: Tentando remover via UAPI...`);
    try {
      const uapiResponse = await axios.get(
        `${config.CPANEL_URL}/execute/DomainInfo/domains_data?format=json`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      console.log(`   📋 Domínios encontrados via UAPI`);
      const domains = uapiResponse.data?.result?.data?.addon_domains || [];
      const mainDomains = uapiResponse.data?.result?.data?.main_domain;
      const subDomains = uapiResponse.data?.result?.data?.sub_domains || [];
      const parkedDomains = uapiResponse.data?.result?.data?.parked_domains || [];

      console.log(`   - Addon Domains: ${domains.length}`);
      console.log(`   - Sub Domains: ${subDomains.length}`);
      console.log(`   - Parked Domains: ${parkedDomains.length}`);

      // Verificar se o domínio está na lista de addon domains
      const isAddonDomain = domains.includes(domainName);
      const isParkedDomain = parkedDomains.includes(domainName);
      const isSubDomain = subDomains.includes(subdomain);

      console.log(`   📌 ${domainName} é Addon Domain? ${isAddonDomain}`);
      console.log(`   📌 ${domainName} é Parked Domain? ${isParkedDomain}`);
      console.log(`   📌 ${subdomain} é Sub Domain? ${isSubDomain}`);

    } catch (uapiError) {
      console.log(`   ⚠️ UAPI não disponível: ${uapiError.message}`);
    }

    // MÉTODO 2: Listar e remover Parked Domains primeiro
    console.log(`\n   🔄 MÉTODO 2: Verificando e removendo Parked Domains...`);
    try {
      const listParkedResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Park&cpanel_jsonapi_func=listparkeddomains`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const parkedDomains = listParkedResponse.data?.cpanelresult?.data || [];
      console.log(`   📋 Total de Parked Domains: ${parkedDomains.length}`);

      // Procurar pelo subdomínio na lista de parked domains
      const parkedSubdomain = parkedDomains.find(pd => pd.domain === subdomain);
      
      if (parkedSubdomain) {
        console.log(`   🎯 Encontrado subdomínio como Parked Domain: ${subdomain}`);
        console.log(`   🗑️ Removendo Parked Domain: ${subdomain}...`);
        
        const unparkResponse = await axios.get(
          `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Park&cpanel_jsonapi_func=unpark&domain=${subdomain}`,
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
          console.log(`   ✅ Parked Domain ${subdomain} removido!`);
        } else {
          console.log(`   ⚠️ Falha ao remover parked: ${unparkResult?.reason}`);
        }
        
        await this.delay(1000);
      }

      // Também verificar parked domains relacionados ao domínio principal
      const relatedParked = parkedDomains.filter(pd => 
        pd.domain?.includes(domainName) && pd.domain !== subdomain
      );

      for (const parked of relatedParked) {
        console.log(`   🗑️ Removendo Parked Domain relacionado: ${parked.domain}...`);
        
        try {
          await axios.get(
            `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Park&cpanel_jsonapi_func=unpark&domain=${parked.domain}`,
            {
              headers: {
                'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
              },
              timeout: 30000,
              httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
          );
          console.log(`      ✅ Removido: ${parked.domain}`);
        } catch (e) {
          console.log(`      ⚠️ Erro: ${e.message}`);
        }
        
        await this.delay(500);
      }

    } catch (parkError) {
      console.log(`   ⚠️ Erro ao listar Parked Domains: ${parkError.message}`);
    }

    // MÉTODO 3: Tentar remover como Addon Domain
    console.log(`\n   🔄 MÉTODO 3: Removendo Addon Domain...`);
    try {
      const addonResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=deladdondomain&domain=${domainName}&subdomain=${subdomain}`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const addonResult = addonResponse.data?.cpanelresult?.data?.[0];
      
      if (addonResult?.result === 1) {
        console.log(`   ✅ Addon Domain removido com sucesso!`);
        return { success: true, message: 'Domínio removido do cPanel com sucesso' };
      } else {
        console.log(`   ⚠️ Addon Domain falhou: ${addonResult?.reason}`);
      }
    } catch (addonError) {
      console.log(`   ⚠️ Erro no Addon Domain: ${addonError.message}`);
    }

    // MÉTODO 4: Tentar remover o domínio principal como Parked Domain
    console.log(`\n   🔄 MÉTODO 4: Tentando remover domínio como Parked...`);
    try {
      const unparkMainResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Park&cpanel_jsonapi_func=unpark&domain=${domainName}`,
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const unparkMainResult = unparkMainResponse.data?.cpanelresult?.data?.[0];
      
      if (unparkMainResult?.result === 1) {
        console.log(`   ✅ Domínio removido como Parked Domain!`);
        return { success: true, message: 'Domínio removido do cPanel com sucesso' };
      } else {
        console.log(`   ⚠️ Parked Domain falhou: ${unparkMainResult?.reason}`);
      }
    } catch (unparkError) {
      console.log(`   ⚠️ Erro no Parked Domain: ${unparkError.message}`);
    }

    // MÉTODO 5: Tentar API2 SubDomain para remover o subdomínio
    console.log(`\n   🔄 MÉTODO 5: Tentando remover subdomínio diretamente...`);
    try {
      // Extrair apenas a parte antes do domínio principal
      // vitalityjourney.online.institutoexperience.com.br -> vitalityjourney.online
      const subdomainPart = domainName.replace(/\./g, '_'); // Substitui pontos por underscores
      
      const subResponse = await axios.get(
        `${config.CPANEL_URL}/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=SubDomain&cpanel_jsonapi_func=delsubdomain&domain=${subdomain}`,
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
        console.log(`   ✅ Subdomínio removido com sucesso!`);
        return { success: true, message: 'Domínio removido do cPanel com sucesso' };
      } else {
        console.log(`   ⚠️ SubDomain falhou: ${subResult?.reason}`);
      }
    } catch (subError) {
      console.log(`   ⚠️ Erro no SubDomain: ${subError.message}`);
    }

    // Se chegou aqui, todos os métodos falharam
    console.log(`\n   ❌ Todos os métodos de remoção falharam`);
    
    // Buscar o erro mais recente para traduzir
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
      return errorMessage; // Retorna original se falhar
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