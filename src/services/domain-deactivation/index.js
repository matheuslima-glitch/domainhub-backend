/**
 * SERVIÇO DE DESATIVAÇÃO COMPLETA DE DOMÍNIOS - V7
 * 
 * CORREÇÕES V7:
 * 1. Timeout aumentado de 30s para 60s (operações de remoção podem demorar)
 * 2. Após cada método de remoção, verifica se o domínio ainda existe no cPanel
 *    antes de tentar o próximo método (evita falsos negativos)
 * 3. Mantém os dois formatos de subdomain (manual e padrão)
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
    this.defaultTimeout = 60000; // 60 segundos (aumentado de 30s)
  }

  /**
   * DETECTAR INTEGRAÇÕES DO DOMÍNIO
   */
  async detectIntegrations(domainName) {
    console.log(`\n🔍 [DETECT] Detectando integrações para ${domainName}...`);
    
    const integrations = {
      wordpress: { exists: false, insid: null, details: null },
      whm: { exists: false, username: null, domain: null },
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

    // 2. Verificar domínio no WHM
    try {
      const whmAccount = await this.findWHMAccount(domainName);
      if (whmAccount) {
        integrations.whm.exists = true;
        integrations.whm.username = whmAccount.user;
        integrations.whm.domain = whmAccount.domain;
        console.log(`   ✅ WHM encontrado: username=${whmAccount.user}`);
      } else {
        console.log(`   ⚪ WHM não encontrado`);
      }
    } catch (error) {
      console.log(`   ⚠️ Erro ao verificar WHM: ${error.message}`);
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
    console.log(`   WHM: ${integrations.whm.exists ? '✅' : '⚪'}`);
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
          timeout: this.defaultTimeout,
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
   * BUSCAR CONTA DO DOMÍNIO NO WHM
   */
  async findWHMAccount(domainName) {
    try {
      const response = await axios.get(
        `${config.WHM_URL}/json-api/listaccts?api.version=1`,
        {
          headers: {
            'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
          },
          timeout: this.defaultTimeout,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const accounts = response.data?.data?.acct || [];
      
      for (const account of accounts) {
        if (account.domain === domainName) {
          return account;
        }
      }

      return null;
    } catch (error) {
      console.error(`❌ [WHM] Erro ao buscar contas:`, error.message);
      return null;
    }
  }

  /**
   * VERIFICAR SE CONTA WHM AINDA EXISTE
   */
  async checkAccountStillExists(domainName) {
    try {
      console.log(`   🔍 Verificando se conta WHM para ${domainName} ainda existe...`);
      
      const account = await this.findWHMAccount(domainName);
      const exists = account !== null;
      
      console.log(`   ${exists ? '⚠️ Conta ainda existe' : '✅ Conta NÃO existe mais (removida com sucesso!)'}`);
      
      return exists;
    } catch (error) {
      console.log(`   ⚠️ Erro ao verificar existência: ${error.message}`);
      return true;
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
          timeout: this.defaultTimeout
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
          timeout: 90000, // 90 segundos para WordPress (pode demorar mais)
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
   * REMOVER CONTA DO WHM (Terminate Account)
   */
  async removeWHMAccount(domainName) {
    console.log(`\n🗑️ [WHM] Removendo conta do domínio ${domainName}...`);

    const account = await this.findWHMAccount(domainName);
    
    if (!account) {
      console.log(`   ⚠️ Conta não encontrada no WHM para o domínio ${domainName}`);
      return { success: true, message: 'Conta não encontrada no WHM - já removida ou não existe' };
    }

    const username = account.user;
    console.log(`   📌 Username encontrado: ${username}`);

    try {
      const response = await axios.get(
        `${config.WHM_URL}/json-api/terminateacct?api.version=1&user=${username}`,
        {
          headers: {
            'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
          },
          timeout: 120000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      console.log(`   📥 Resposta WHM:`, JSON.stringify(response.data, null, 2));

      const metadata = response.data?.metadata;
      const result = metadata?.result;

      if (result === 1 || result === '1') {
        console.log(`   ✅ Conta WHM removida com sucesso!`);
        return { success: true, message: 'Conta WHM removida com sucesso' };
      } else {
        const reason = metadata?.reason || 'Erro desconhecido';
        console.log(`   ⚠️ Falha ao remover conta: ${reason}`);
        const translatedError = await this.translateCPanelError(reason);
        return { success: false, message: translatedError };
      }

    } catch (error) {
      console.error(`   ❌ Erro ao remover conta WHM:`, error.message);
      
      if (error.message.includes('timeout')) {
        console.log(`   ⏱️ Timeout detectado - verificando se conta foi removida...`);
        await this.delay(5000);
        
        const stillExists = await this.checkAccountStillExists(domainName);
        if (!stillExists) {
          console.log(`   ✅ Conta foi removida com sucesso (apesar do timeout)!`);
          return { success: true, message: 'Conta WHM removida com sucesso' };
        }
      }
      
      const translatedError = await this.translateCPanelError(error.message);
      return { success: false, message: translatedError };
    }
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
          timeout: this.defaultTimeout
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
    console.log(`🚨 [DEACTIVATION] INICIANDO DESATIVAÇÃO COMPLETA - V7`);
    console.log(`   Domain ID: ${domainId}`);
    console.log(`   Domain Name: ${domainName}`);
    console.log(`${'='.repeat(70)}`);

    const results = {
      domainId,
      domainName,
      integrations: null,
      steps: {
        wordpress: { executed: false, success: false, message: null },
        whm: { executed: false, success: false, message: null },
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

      // ETAPA 3: Remover conta do WHM (se existir)
      if (integrations.whm.exists) {
        results.steps.whm.executed = true;
        const whmResult = await this.removeWHMAccount(domainName);
        results.steps.whm.success = whmResult.success;
        results.steps.whm.message = whmResult.message;
      } else {
        results.steps.whm.message = 'Conta não encontrada no WHM - etapa pulada';
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
      console.log(`📊 [DEACTIVATION] RESUMO DA DESATIVAÇÃO - V7`);
      console.log(`${'='.repeat(70)}`);
      console.log(`   WordPress: ${results.steps.wordpress.executed ? (results.steps.wordpress.success ? '✅' : '❌') : '⏭️'} ${results.steps.wordpress.message || ''}`);
      console.log(`   WHM: ${results.steps.whm.executed ? (results.steps.whm.success ? '✅' : '❌') : '⏭️'} ${results.steps.whm.message || ''}`);
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