/**
 * COMPRA DE DOMÍNIOS ATOMICAT - VERSÃO CORRIGIDA FINAL
 * IMPORTANTE: AtomiCat APENAS compra o domínio
 * NÃO configura Cloudflare
 * NÃO instala WordPress
 * NÃO adiciona ao cPanel
 */

const axios = require('axios');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');

// Inicializar Supabase
const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_KEY
);

class AtomiCatDomainPurchase {
  constructor() {
    // Configurações de APIs
    this.namecheapAPI = 'https://api.namecheap.com/xml.response';
    this.openaiAPI = 'https://api.openai.com/v1/chat/completions';
    this.godaddyAPI = 'https://api.godaddy.com/v1';
    
    // Configurações de compra
    this.maxRetries = 10;
    this.priceLimit = 1.00;
    
    // Dados de contato para registro
    this.registrantInfo = {
      FirstName: 'Gabriel',
      LastName: 'Gomes',
      Address1: 'Rua Lambari Nanuque',
      City: 'Belo Horizonte',
      StateProvince: 'MG',
      PostalCode: '39860000',
      Country: 'BR',
      Phone: '+55.31990630909',
      EmailAddress: 'gabrielbngomes0987@gmail.com',
      OrganizationName: 'Instituto Experience'
    };
  }

  /**
   * FUNÇÃO PRINCIPAL - ORQUESTRA TODO O PROCESSO ATOMICAT
   * ATENÇÃO: Apenas compra o domínio, sem configurações adicionais
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId } = params;
    
    console.log(`🚀 [ATOMICAT] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    console.log(`   ⚠️ MODO ATOMICAT: Apenas compra de domínio, SEM Cloudflare e SEM WordPress`);
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo AtomiCat...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Se for compra manual, processar diretamente
    if (domainManual) {
      console.log(`🔍 [MANUAL-ATOMICAT] Processando domínio manual: ${domainManual}`);
      
      // Verificar disponibilidade com GoDaddy
      const availabilityCheck = await this.checkDomainAvailability(domainManual);
      
      if (!availabilityCheck.available) {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Domínio ${domainManual} não está disponível`);
        return { success: false, error: 'Domínio não disponível' };
      }
      
      // Comprar domínio
      const purchaseResult = await this.purchaseDomainNamecheap(domainManual);
      
      if (purchaseResult.success) {
        domainsToRegister.push(domainManual);
        successCount = 1;
        
        // ATOMICAT: Apenas salvar no banco e notificar
        const savedDomain = await this.saveDomainToSupabase(domainManual, userId);
        if (savedDomain?.domain_id) {
          await this.saveActivityLog(savedDomain.domain_id, userId);
        }
        await this.sendWhatsAppNotification(domainManual, 'success');
      } else {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Erro na compra: ${purchaseResult.error}`);
        return { success: false, error: purchaseResult.error };
      }
      
    } else {
      // Compra com IA
      for (let i = 0; i < quantidade; i++) {
        let domain = null;
        let retries = 0;
        
        while (!domain && retries < this.maxRetries) {
          try {
            // GERAR DOMÍNIO GENÉRICO
            console.log(`🤖 [AI-ATOMICAT] Gerando domínio genérico ${i + 1}/${quantidade}`);
            await this.updateProgress(sessionId, 'generating', 'in_progress', 
              `Gerando domínio genérico ${i + 1}/${quantidade}`);
            
            const generatedDomain = await this.generateGenericDomainWithAI(nicho, idioma, retries > 0);
            
            if (!generatedDomain) {
              console.error('❌ Falha ao gerar domínio com IA');
              retries++;
              await this.delay(2000);
              continue;
            }
            
            // VERIFICAR DISPONIBILIDADE COM GODADDY
            console.log(`🔍 [GODADDY] Verificando: ${generatedDomain}`);
            await this.updateProgress(sessionId, 'checking', 'in_progress', 
              `Verificando disponibilidade de ${generatedDomain}...`);
            
            const availabilityCheck = await this.checkDomainAvailability(generatedDomain);
            
            if (!availabilityCheck.available) {
              console.log(`❌ Domínio indisponível: ${generatedDomain}`);
              retries++;
              await this.delay(2000);
              continue;
            }
            
            console.log(`✅ Domínio disponível: ${generatedDomain}`);
            
            // VERIFICAR PREÇO
            if (availabilityCheck.price > this.priceLimit) {
              console.log(`💸 Domínio muito caro: $${availabilityCheck.price}`);
              retries++;
              await this.delay(2000);
              continue;
            }
            
            // COMPRAR DOMÍNIO
            console.log(`💳 Comprando: ${generatedDomain}`);
            await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
              `Comprando ${generatedDomain}...`);
            
            const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain);
            
            if (purchaseResult.success) {
              domain = generatedDomain;
              domainsToRegister.push(domain);
              successCount++;
              
              console.log(`✅ [ATOMICAT] Domínio comprado: ${domain}`);
              console.log(`   ⚠️ Configurações Cloudflare e WordPress NÃO serão executadas (modo AtomiCat)`);
              
              // ATOMICAT: Apenas salvar no banco e notificar
              const savedDomain = await this.saveDomainToSupabase(domain, userId);
              if (savedDomain?.domain_id) {
                await this.saveActivityLog(savedDomain.domain_id, userId);
              }
              await this.sendWhatsAppNotification(domain, 'success');
              
            } else {
              console.error(`❌ Erro na compra: ${purchaseResult.error}`);
              
              if (purchaseResult.error.includes('insufficient funds')) {
                await this.updateProgress(sessionId, 'error', 'error', 
                  'Saldo insuficiente na conta Namecheap');
                break;
              }
              
              retries++;
              await this.delay(3000);
            }
            
          } catch (error) {
            console.error(`❌ Erro na tentativa ${retries + 1}:`, error.message);
            retries++;
            await this.delay(3000);
          }
        }
        
        if (!domain) {
          console.error(`❌ Não foi possível comprar o domínio ${i + 1} após ${this.maxRetries} tentativas`);
        }
      }
    }
    
    // Callback final
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) AtomiCat comprado(s) com sucesso!`, 
        domainsToRegister[domainsToRegister.length - 1]);
    } else {
      await this.updateProgress(sessionId, 'error', 'error', 
        'Nenhum domínio foi comprado');
    }
    
    return {
      success: successCount > 0,
      domainsRegistered: domainsToRegister,
      totalRequested: quantidade,
      totalRegistered: successCount
    };
  }

  /**
   * VERIFICAR DISPONIBILIDADE - GODADDY
   * Esta implementação está correta e funcional
   */
  async checkDomainAvailability(domain) {
    if (!config.GODADDY_API_KEY || !config.GODADDY_API_SECRET) {
      console.error('❌ [GODADDY] API não configurada!');
      console.error('   Configure GODADDY_API_KEY e GODADDY_API_SECRET no Render');
      return { available: false, error: 'GoDaddy API não configurada' };
    }

    try {
      console.log(`🔍 [GODADDY-ATOMICAT] Verificando disponibilidade de ${domain}...`);
      console.log(`   URL: ${this.godaddyAPI}/domains/available?domain=${domain}`);
      
      const response = await axios.get(
        `${this.godaddyAPI}/domains/available`,
        {
          params: {
            domain: domain,
            checkType: 'FULL',
            forTransfer: false
          },
          headers: {
            'Authorization': `sso-key ${config.GODADDY_API_KEY}:${config.GODADDY_API_SECRET}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          timeout: 15000,
          validateStatus: function (status) {
            return status >= 200 && status < 300;
          }
        }
      );

      const data = response.data;
      const isAvailable = data.available === true;
      
      // Pegar preço se disponível
      let price = 0.99;
      if (data.price) {
        price = data.price / 100;
      }

      console.log(`📊 [GODADDY-ATOMICAT] ${domain}`);
      console.log(`   Disponível: ${isAvailable ? '✅ SIM' : '❌ NÃO'}`);
      console.log(`   Definitivo: ${data.definitive ? 'SIM' : 'NÃO'}`);
      console.log(`   Preço: $${price.toFixed(2)}`);
      console.log(`   Moeda: ${data.currency || 'USD'}`);
      
      return {
        available: isAvailable,
        price: price,
        definitive: data.definitive || false
      };

    } catch (error) {
      console.error('❌ [GODADDY-ATOMICAT] Erro na verificação:', error.message);
      
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, error.response.data);
        
        if (error.response.status === 401) {
          console.error('❌ [GODADDY] Erro 401: Credenciais inválidas');
          console.error('   Verifique GODADDY_API_KEY e GODADDY_API_SECRET');
          return { available: false, error: 'Autenticação GoDaddy falhou (401)' };
        }
        
        if (error.response.status === 403) {
          console.error('❌ [GODADDY] Erro 403: Sem permissão');
          console.error('   Verifique se a API Key tem permissões corretas');
          return { available: false, error: 'Sem permissão GoDaddy (403)' };
        }
        
        if (error.response.status === 404) {
          console.error('❌ [GODADDY] Erro 404: Domínio não encontrado ou inválido');
          return { available: false, error: 'Domínio inválido (404)' };
        }
      }
      
      return { 
        available: false, 
        error: error.message || 'Erro na verificação de disponibilidade' 
      };
    }
  }

  /**
   * GERAR DOMÍNIO GENÉRICO COM IA
   * AtomiCat gera domínios mais genéricos e versáteis
   */
  async generateGenericDomainWithAI(nicho, idioma, isRetry) {
    if (!config.OPENAI_API_KEY) {
      console.error('❌ OpenAI API não configurada');
      throw new Error('OpenAI API Key não configurada');
    }

    try {
      console.log(`🤖 [AI-ATOMICAT] Gerando domínio genérico para nicho: ${nicho}`);
      
      const prompt = this.buildGenericPrompt(nicho, idioma, isRetry);
      
      const response = await axios.post(
        this.openaiAPI,
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Você é um especialista em criar nomes de domínios genéricos, versáteis e memoráveis para múltiplos usos.' },
            { role: 'user', content: prompt }
          ],
          temperature: isRetry ? 1.0 : 0.7,
          max_tokens: 150
        },
        {
          headers: {
            'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const content = response.data.choices[0].message.content.trim();
      console.log(`🤖 [AI-ATOMICAT] Resposta bruta:`, content);
      
      // Tentar extrair JSON
      let domains = [];
      
      // Remover markdown se houver
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      try {
        const parsed = JSON.parse(cleanContent);
        domains = parsed.domains || [];
      } catch (parseError) {
        console.error('❌ Erro ao parsear JSON:', parseError.message);
        // Tentar extrair domínio manualmente
        const match = content.match(/([a-z0-9]+)\.online/i);
        if (match) {
          domains = [match[0].toLowerCase()];
        }
      }
      
      if (domains.length === 0) {
        console.error('❌ Nenhum domínio gerado pela IA');
        return null;
      }
      
      const domain = domains[0].toLowerCase().trim();
      console.log(`✅ [AI-ATOMICAT] Domínio genérico gerado: ${domain}`);
      
      // Validar formato
      if (!domain.endsWith('.online')) {
        console.error(`❌ Domínio inválido (sem .online): ${domain}`);
        return null;
      }
      
      if (!/^[a-z0-9]+\.online$/.test(domain)) {
        console.error(`❌ Domínio com caracteres inválidos: ${domain}`);
        return null;
      }
      
      return domain;
      
    } catch (error) {
      console.error('❌ [AI-ATOMICAT] Erro:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * COMPRAR DOMÍNIO NA NAMECHEAP
   */
  async purchaseDomainNamecheap(domain) {
    try {
      console.log(`💳 [NAMECHEAP-ATOMICAT] Comprando: ${domain}`);
      
      const domainParts = domain.split('.');
      const domainName = domainParts[0];
      const tld = domainParts.slice(1).join('.');
      
      const clientIP = config.NAMECHEAP_CLIENT_IP;
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: clientIP,
        DomainName: domainName,
        TLD: tld,
        Years: '1',
        
        // Tech Contact
        TechFirstName: this.registrantInfo.FirstName,
        TechLastName: this.registrantInfo.LastName,
        TechAddress1: this.registrantInfo.Address1,
        TechCity: this.registrantInfo.City,
        TechStateProvince: this.registrantInfo.StateProvince,
        TechPostalCode: this.registrantInfo.PostalCode,
        TechCountry: this.registrantInfo.Country,
        TechPhone: this.registrantInfo.Phone,
        TechEmailAddress: this.registrantInfo.EmailAddress,
        TechOrganizationName: this.registrantInfo.OrganizationName,
        
        // Admin Contact
        AdminFirstName: this.registrantInfo.FirstName,
        AdminLastName: this.registrantInfo.LastName,
        AdminAddress1: this.registrantInfo.Address1,
        AdminCity: this.registrantInfo.City,
        AdminStateProvince: this.registrantInfo.StateProvince,
        AdminPostalCode: this.registrantInfo.PostalCode,
        AdminCountry: this.registrantInfo.Country,
        AdminPhone: this.registrantInfo.Phone,
        AdminEmailAddress: this.registrantInfo.EmailAddress,
        AdminOrganizationName: this.registrantInfo.OrganizationName,
        
        // Registrant Contact
        RegistrantFirstName: this.registrantInfo.FirstName,
        RegistrantLastName: this.registrantInfo.LastName,
        RegistrantAddress1: this.registrantInfo.Address1,
        RegistrantCity: this.registrantInfo.City,
        RegistrantStateProvince: this.registrantInfo.StateProvince,
        RegistrantPostalCode: this.registrantInfo.PostalCode,
        RegistrantCountry: this.registrantInfo.Country,
        RegistrantPhone: this.registrantInfo.Phone,
        RegistrantEmailAddress: this.registrantInfo.EmailAddress,
        RegistrantOrganizationName: this.registrantInfo.OrganizationName,
        
        AddFreeWhoisguard: 'no',
        WGEnabled: 'no',
        GenerateAdminOrderRefId: 'False',
        IsPremiumDomain: 'False'
      };
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      const xmlData = response.data;
      
      if (xmlData.includes('Status="ERROR"') || xmlData.includes('<Error')) {
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        const errorMessage = errorMatch ? errorMatch[1] : 'Erro desconhecido';
        console.error(`❌ [NAMECHEAP-ATOMICAT] Erro: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
      
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        console.log(`✅ [NAMECHEAP-ATOMICAT] Domínio ${domain} comprado!`);
        return { success: true, domain: domain };
      }
      
      console.error(`❌ [NAMECHEAP-ATOMICAT] Resposta inesperada`);
      return { success: false, error: 'Resposta inesperada da Namecheap' };
      
    } catch (error) {
      console.error(`❌ [NAMECHEAP-ATOMICAT] Erro na compra:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * SALVAR DOMÍNIO NO SUPABASE
   * AtomiCat salva sem nameservers e sem dns_configured
   */
  async saveDomainToSupabase(domain, userId) {
    try {
      const currentDate = new Date().toISOString();
      const expirationDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      
      const payload = {
        p_user_id: userId || config.SUPABASE_USER_ID,
        p_domain_name: domain,
        p_expiration_date: expirationDate,
        p_purchase_date: currentDate,
        p_status: 'active',
        p_registrar: 'Namecheap',
        p_integration_source: 'ai_purchase_atomicat',
        p_last_stats_update: currentDate,
        p_nameservers: null, // AtomiCat não configura nameservers
        p_dns_configured: false, // AtomiCat não configura DNS
        p_auto_renew: false
      };
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE-ATOMICAT] Erro:', error);
        return null;
      }
      
      console.log('✅ [SUPABASE-ATOMICAT] Domínio salvo');
      
      // Buscar o domain_id para o log
      const { data: domainData } = await supabase
        .from('domains')
        .select('domain_id')
        .eq('domain_name', domain)
        .eq('user_id', userId || config.SUPABASE_USER_ID)
        .single();
      
      return domainData;
      
    } catch (error) {
      console.error('❌ [SUPABASE-ATOMICAT] Erro:', error.message);
      return null;
    }
  }

  /**
   * REGISTRAR NO LOG DE ATIVIDADES
   */
  async saveActivityLog(domainId, userId) {
    try {
      const { error } = await supabase
        .from('domain_activity_logs')
        .insert({
          domain_id: domainId,
          user_id: userId || config.SUPABASE_USER_ID,
          action_type: 'created',
          old_value: null,
          new_value: 'Domínio comprado com IA - AtomiCat (sem WordPress)'
        });
      
      if (error) {
        console.error('❌ [LOG-ATOMICAT] Erro:', error);
      } else {
        console.log('✅ [LOG-ATOMICAT] Atividade registrada');
      }
      
    } catch (error) {
      console.error('❌ [LOG-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * ENVIAR NOTIFICAÇÃO WHATSAPP
   */
  async sendWhatsAppNotification(domain, status) {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ WhatsApp não configurado');
      return;
    }
    
    try {
      const phoneNumber = config.WHATSAPP_PHONE_NUMBER || '5531999999999';
      
      const dataFormatada = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }).format(new Date()).replace(', ', ' ');
      
      let message;
      if (status === 'success') {
        message = `🚀 *NOVO DOMÍNIO ATOMICAT COMPRADO!*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `🎯 *Tipo:* AtomiCat (Genérico)\n` +
          `🌐 *URL:* https://${domain}\n` +
          `📅 *Data:* ${dataFormatada}\n` +
          `✅ *Status:* Compra realizada com sucesso\n\n` +
          `🎨 Domínio genérico pronto para múltiplos usos!\n` +
          `Ideal para campanhas e produtos variados.\n\n` +
          `⚠️ Cloudflare e WordPress NÃO foram configurados (modo AtomiCat)\n\n` +
          `_Sistema DomainHub - AtomiCat_`;
      } else {
        message = `❌ *ERRO NA COMPRA ATOMICAT*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `🎯 *Tipo:* AtomiCat\n` +
          `📅 *Data:* ${dataFormatada}\n` +
          `⚠️ *Status:* ${status}\n\n` +
          `_Sistema DomainHub - AtomiCat_`;
      }
      
      await axios.post(
        `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}/send-text`,
        {
          phone: phoneNumber.replace(/\D/g, ''),
          message: message
        },
        { timeout: 10000 }
      );
      
      console.log('✅ [WHATSAPP-ATOMICAT] Notificação enviada');
      
    } catch (error) {
      console.error('❌ [WHATSAPP-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * ATUALIZAR PROGRESSO
   */
  async updateProgress(sessionId, step, status, message, domainName = null) {
    try {
      const { error } = await supabase
        .from('domain_purchase_progress')
        .upsert({
          session_id: sessionId,
          step: step,
          status: status,
          message: message,
          domain_name: domainName,
          platform: 'atomicat',
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id' });
      
      if (error) {
        console.error('❌ [CALLBACK-ATOMICAT] Erro:', error);
      } else {
        console.log(`📊 [CALLBACK-ATOMICAT] Progresso: ${step} - ${status}`);
      }
      
    } catch (error) {
      console.error('❌ [CALLBACK-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * VERIFICAR SALDO
   */
  async checkBalance() {
    try {
      const clientIP = config.NAMECHEAP_CLIENT_IP;
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.users.getBalances',
        ClientIp: clientIP
      };
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 15000 });
      const xmlData = response.data;
      
      const balanceMatch = xmlData.match(/Balance="([^"]+)"/);
      const balance = balanceMatch ? parseFloat(balanceMatch[1]) : 0;
      
      console.log(`💰 [ATOMICAT] Saldo: $${balance}`);
      return balance;
      
    } catch (error) {
      console.error('❌ [ATOMICAT] Erro saldo:', error.message);
      return 0;
    }
  }

  /**
   * HELPERS
   */
  buildGenericPrompt(nicho, idioma, isRetry) {
    const idiomaMap = {
      'portuguese': 'português',
      'english': 'inglês',
      'spanish': 'espanhol',
      'german': 'alemão',
      'french': 'francês'
    };
    
    const lang = idiomaMap[idioma] || 'português';
    
    let prompt = `
    Gere um nome de domínio GENÉRICO e VERSÁTIL seguindo estas regras:
    1. Use SEMPRE a extensão .online
    2. Use 2 ou 3 palavras juntas que sejam genéricas e amplas
    3. NUNCA use acentos, cedilha, traços ou caracteres especiais
    4. O domínio deve ser em ${lang}
    5. Inspirado no nicho: ${nicho} (mas não específico demais)
    6. Deve ser adaptável para múltiplos produtos e campanhas
    7. Evite termos muito específicos ou técnicos
    
    Exemplos de domínios genéricos bons:
    - vidasaudavel.online (genérico para saúde)
    - sucessototal.online (genérico para negócios)
    - belezaperfeita.online (genérico para beleza)
    
    Retorne APENAS um JSON no formato:
    {"domains": ["dominio.online"]}
    `;
    
    if (isRetry) {
      prompt += '\n\nSeja MUITO criativo e use combinações incomuns mas ainda genéricas.';
    }
    
    return prompt;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AtomiCatDomainPurchase;