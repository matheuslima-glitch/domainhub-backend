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
   * Busca no cPanel individual da conta WHM
   */
  async findWordPressInstallation(domainName) {
    try {
      console.log(`   🔍 [WP] Iniciando busca de WordPress para ${domainName}...`);
      
      // Primeiro, encontrar a conta WHM do domínio para obter o username
      const whmAccount = await this.findWHMAccount(domainName);
      
      if (!whmAccount) {
        console.log(`   ⚪ [WP] Conta WHM não encontrada para ${domainName} - não é possível verificar WordPress`);
        return null;
      }

      const username = whmAccount.user;
      console.log(`   🔍 [WP] Buscando WordPress no cPanel do usuário: ${username}`);

      // Criar sessão no cPanel do usuário via WHM
      console.log(`   🔑 [WP] Criando sessão no cPanel...`);
      const sessionResponse = await axios.get(
        `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${username}&service=cpaneld`,
        {
          headers: {
            'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
          },
          timeout: this.defaultTimeout,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const sessionData = sessionResponse.data?.data;
      const cpSecurityToken = sessionData?.cp_security_token;

      if (!cpSecurityToken) {
        console.log(`   ⚠️ [WP] Não foi possível criar sessão no cPanel do usuário ${username}`);
        return null;
      }

      console.log(`   ✅ [WP] Sessão criada com sucesso`);

      // Buscar instalações do Softaculous no cPanel do usuário
      const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
      const softUrl = `${baseUrl}${cpSecurityToken}${this.softaculousPath}?act=installations&soft=26&api=json`;

      const response = await axios.get(softUrl, {
        headers: {
          'Cookie': `cpsession=${sessionData.session}`
        },
        timeout: this.defaultTimeout,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });

      const installations = response.data?.installations?.['26'] || {};
      const installCount = Object.keys(installations).length;
      
      console.log(`   📋 [WP] Total de instalações WordPress encontradas: ${installCount}`);

      for (const [insid, installation] of Object.entries(installations)) {
        if (installation.softdomain === domainName) {
          console.log(`   ✅ [WP] WordPress encontrado! insid=${insid}`);
          return { ...installation, insid, cPanelUsername: username };
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
   * Desinstala no cPanel individual da conta WHM
   */
  async uninstallWordPress(insid, domainName) {
    console.log(`\n🗑️ [WORDPRESS] Desinstalando WordPress (insid: ${insid})...`);

    try {
      // Primeiro, encontrar a conta WHM do domínio para obter o username
      const whmAccount = await this.findWHMAccount(domainName);
      
      if (!whmAccount) {
        console.log(`   ⚠️ Conta WHM não encontrada - não é possível desinstalar WordPress`);
        return { success: false, message: 'Conta WHM não encontrada' };
      }

      const username = whmAccount.user;
      console.log(`   📌 Desinstalando do cPanel do usuário: ${username}`);

      // Criar sessão no cPanel do usuário via WHM
      const sessionResponse = await axios.get(
        `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${username}&service=cpaneld`,
        {
          headers: {
            'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
          },
          timeout: this.defaultTimeout,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        }
      );

      const sessionData = sessionResponse.data?.data;
      const cpSecurityToken = sessionData?.cp_security_token;

      if (!cpSecurityToken) {
        console.log(`   ⚠️ Não foi possível criar sessão no cPanel`);
        return { success: false, message: 'Não foi possível criar sessão no cPanel' };
      }

      // Desinstalar WordPress via Softaculous
      const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
      const softUrl = `${baseUrl}${cpSecurityToken}${this.softaculousPath}?act=remove&insid=${insid}&api=json`;

      const response = await axios.post(
        softUrl,
        'removeins=1&remove_dir=1&remove_db=1',
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': `cpsession=${sessionData.session}`
          },
          timeout: 90000,
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
        `${config.WHM_URL}/json-api/removeacct?api.version=1&username=${username}`,
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
        // "A API respondeu 200" não é prova de que a zona sumiu. Conferimos
        // consultando de volta — mesma razão pela qual removeWHMAccount já
        // chama checkAccountStillExists desde a V7.
        await this.delay(1500);
        const confere = await this.confirmarAusencia(domainName);

        if (confere.estado.cloudflare.situacao === 'ausente') {
          console.log(`   ✅ Zona Cloudflare removida e confirmada!`);
          return { success: true, message: 'Zona Cloudflare removida e confirmada' };
        }

        if (confere.estado.cloudflare.situacao === 'presente') {
          console.log(`   ❌ A API aceitou o delete mas a zona CONTINUA lá`);
          return {
            success: false,
            message: `A Cloudflare aceitou a remoção mas a zona continua existindo (${confere.estado.cloudflare.detalhe})`
          };
        }

        console.log(`   ⚠️ Delete aceito, mas não deu para confirmar: ${confere.estado.cloudflare.detalhe}`);
        return {
          success: false,
          message: `Remoção enviada, mas não foi possível confirmar: ${confere.estado.cloudflare.detalhe}`
        };
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
   * CONFIRMAR QUE O DOMÍNIO SUMIU DE TODOS OS SERVIÇOS
   *
   * Por que não dá para usar detectIntegrations() aqui: as três buscas dela
   * (findWordPressInstallation, findWHMAccount, findCloudflareZone) engolem o
   * erro e devolvem `null`. Um timeout da Cloudflare fica IDÊNTICO a "a zona
   * não existe" — exatamente a confusão que permite marcar como desativado um
   * domínio que continua no ar.
   *
   * Aqui cada serviço tem três estados, e "não consegui verificar" NÃO é
   * "está limpo":
   *
   *   'ausente'        confirmado: o serviço respondeu e não tem o domínio
   *   'presente'       confirmado: o serviço respondeu e ainda tem
   *   'indeterminado'  o serviço não respondeu — não sabemos
   *
   * O WordPress é DERIVADO do WHM de propósito. A instalação vive dentro da
   * conta cPanel (ver findWordPressInstallation), então conta ausente implica
   * instalação ausente. E quando a conta ainda existe, o WHM já basta para
   * barrar — não precisamos de uma verificação própria que teria os mesmos
   * problemas de engolir erro.
   */
  async confirmarAusencia(domainName) {
    const estado = {
      cloudflare: { situacao: 'indeterminado', detalhe: null },
      whm: { situacao: 'indeterminado', detalhe: null },
      wordpress: { situacao: 'indeterminado', detalhe: null }
    };

    // ── Cloudflare ────────────────────────────────────────────────────
    if (!config.CLOUDFLARE_EMAIL || !config.CLOUDFLARE_API_KEY) {
      estado.cloudflare.detalhe = 'Cloudflare não configurado — impossível verificar';
    } else {
      try {
        const resposta = await axios.get(`${this.cloudflareAPI}/zones?name=${domainName}`, {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: this.defaultTimeout
        });

        if (resposta.data?.success !== true) {
          estado.cloudflare.detalhe = `A Cloudflare recusou a consulta: ${JSON.stringify(resposta.data?.errors)}`;
        } else {
          const zonas = resposta.data?.result || [];
          estado.cloudflare.situacao = zonas.length > 0 ? 'presente' : 'ausente';
          if (zonas.length > 0) estado.cloudflare.detalhe = `zona ${zonas[0].id} (${zonas[0].status})`;
        }
      } catch (erro) {
        estado.cloudflare.detalhe = `Não respondeu: ${erro.message}`;
      }
    }

    // ── WHM ───────────────────────────────────────────────────────────
    if (!config.WHM_URL || !config.WHM_API_TOKEN) {
      estado.whm.detalhe = 'WHM não configurado — impossível verificar';
    } else {
      try {
        const resposta = await axios.get(`${config.WHM_URL}/json-api/listaccts?api.version=1`, {
          headers: { Authorization: `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}` },
          timeout: this.defaultTimeout,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });

        const contas = resposta.data?.data?.acct;
        if (!Array.isArray(contas)) {
          estado.whm.detalhe = 'Resposta do WHM sem a lista de contas';
        } else {
          const achada = contas.find((a) => a.domain === domainName);
          estado.whm.situacao = achada ? 'presente' : 'ausente';
          if (achada) estado.whm.detalhe = `conta ${achada.user}`;
        }
      } catch (erro) {
        estado.whm.detalhe = `Não respondeu: ${erro.message}`;
      }
    }

    // ── WordPress, derivado do WHM ────────────────────────────────────
    if (estado.whm.situacao === 'ausente') {
      estado.wordpress.situacao = 'ausente';
      estado.wordpress.detalhe = 'conta cPanel não existe, então a instalação também não';
    } else if (estado.whm.situacao === 'presente') {
      estado.wordpress.detalhe = 'a conta cPanel ainda existe — resolva o WHM primeiro';
    } else {
      estado.wordpress.detalhe = 'depende do WHM, que não pôde ser verificado';
    }

    const pendencias = Object.entries(estado)
      .filter(([, v]) => v.situacao !== 'ausente')
      .map(([servico, v]) => `${servico}: ${v.situacao}${v.detalhe ? ` (${v.detalhe})` : ''}`);

    return { estado, limpo: pendencias.length === 0, pendencias };
  }

  /**
   * DESATIVAR DOMÍNIO NO SUPABASE — só quando REALMENTE saiu de tudo
   *
   * A trava mora aqui, e não no orquestrador, porque o painel chama as etapas
   * uma a uma por endpoints separados: `/step/supabase` é acionável sozinho,
   * sem passar por deactivateDomain(). Guardar só o orquestrador deixaria a
   * porta da frente aberta.
   *
   * Antes de 15/09/2026 este método gravava incondicionalmente, e
   * `overallSuccess` olhava apenas para ele. Resultado: WordPress, WHM e
   * Cloudflare podiam falhar e a desativação ainda relatava ✅ SUCESSO — o
   * domínio sumia do painel enquanto o site seguia no ar. Encontrado em
   * theflashburn.online, marcado como desativado com a zona ativa e 286.289
   * requisições nos 14 dias anteriores.
   *
   * Desligar a trava sem deploy: DESATIVACAO_ESTRITA=false no Render.
   */
  async deactivateInSupabase(domainId, domainNameConhecido = null) {
    console.log(`\n💾 [SUPABASE] Desativando domínio no banco de dados...`);

    try {
      // O nome vem do banco quando não é passado: o painel manda só o id para
      // `/step/supabase`, e sem o nome não há como verificar nada.
      let domainName = domainNameConhecido;

      if (!domainName) {
        const { data, error } = await supabase
          .from('domains')
          .select('domain_name')
          .eq('id', domainId)
          .maybeSingle();

        if (error) {
          console.error(`   ❌ Erro ao ler o domínio: ${error.message}`);
          return { success: false, message: `Erro ao ler o domínio: ${error.message}` };
        }
        if (!data) {
          return { success: false, message: `Domínio ${domainId} não encontrado` };
        }
        domainName = data.domain_name;
      }

      if (config.DESATIVACAO_ESTRITA) {
        console.log(`   🔒 Conferindo se ${domainName} saiu de todos os serviços...`);
        const { limpo, pendencias } = await this.confirmarAusencia(domainName);

        if (!limpo) {
          console.log(`   ⛔ NÃO vou marcar como desativado. Ainda pendente:`);
          pendencias.forEach((p) => console.log(`      • ${p}`));
          return {
            success: false,
            bloqueado: true,
            pendencias,
            message:
              `O domínio ainda não saiu de tudo, então NÃO foi marcado como desativado. ` +
              `Pendente — ${pendencias.join(' · ')}`
          };
        }

        console.log(`   ✅ Confirmado: fora do Cloudflare, do WHM e do WordPress.`);
      } else {
        console.warn(`   ⚠️ DESATIVACAO_ESTRITA=false — marcando sem conferir`);
      }

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
        const wpResult = await this.uninstallWordPress(integrations.wordpress.insid, domainName);
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

      // ETAPA 5: Desativar no Supabase
      //
      // Continua sendo chamada mesmo com etapas anteriores falhando — não para
      // gravar, e sim porque deactivateInSupabase() reconfere os três serviços
      // e devolve a lista exata do que ficou pendente. É mais útil que um
      // "pulado" genérico, e a gravação só acontece se estiver tudo limpo.
      results.steps.supabase.executed = true;
      const supabaseResult = await this.deactivateInSupabase(domainId, domainName);
      results.steps.supabase.success = supabaseResult.success;
      results.steps.supabase.message = supabaseResult.message;
      if (supabaseResult.pendencias) results.pendencias = supabaseResult.pendencias;

      // SUCESSO EXIGE QUE TUDO TENHA DADO CERTO.
      //
      // Antes de 15/09/2026 esta linha era `results.overallSuccess =
      // results.steps.supabase.success`, e por isso WordPress, WHM e Cloudflare
      // podiam falhar sem afetar o resultado: bastava a gravação no banco
      // funcionar para o relatório dizer ✅ SUCESSO. O domínio saía do painel
      // como desativado enquanto o site continuava no ar.
      //
      // Etapa PULADA (a integração não existia) não conta contra — ela não
      // tinha o que fazer. Só as executadas precisam ter dado certo.
      const executadasComFalha = Object.entries(results.steps)
        .filter(([, s]) => s.executed && !s.success)
        .map(([nome]) => nome);

      results.overallSuccess = executadasComFalha.length === 0;
      results.failedSteps = executadasComFalha;
      results.completedAt = new Date().toISOString();

      // Log final
      console.log(`\n${'='.repeat(70)}`);
      console.log(`📊 [DEACTIVATION] RESUMO DA DESATIVAÇÃO - V7`);
      console.log(`${'='.repeat(70)}`);
      console.log(`   WordPress: ${results.steps.wordpress.executed ? (results.steps.wordpress.success ? '✅' : '❌') : '⏭️'} ${results.steps.wordpress.message || ''}`);
      console.log(`   WHM: ${results.steps.whm.executed ? (results.steps.whm.success ? '✅' : '❌') : '⏭️'} ${results.steps.whm.message || ''}`);
      console.log(`   Cloudflare: ${results.steps.cloudflare.executed ? (results.steps.cloudflare.success ? '✅' : '❌') : '⏭️'} ${results.steps.cloudflare.message || ''}`);
      console.log(`   Supabase: ${results.steps.supabase.executed ? (results.steps.supabase.success ? '✅' : '❌') : '⏭️'} ${results.steps.supabase.message || ''}`);
      if (results.overallSuccess) {
        console.log(`\n   Status Geral: ✅ SUCESSO — saiu de todos os serviços e foi marcado no banco`);
      } else {
        console.log(`\n   Status Geral: ❌ NÃO CONCLUÍDO — etapa(s) com falha: ${results.failedSteps.join(', ')}`);
        console.log(`   O domínio NÃO foi marcado como desativado e continua visível no painel.`);
        (results.pendencias || []).forEach((p) => console.log(`      • ainda em ${p}`));
      }
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