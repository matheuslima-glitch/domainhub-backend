/**
 * COMPRA DE DOMÍNIOS ATOMICAT - VERSÃO COMPLETA CORRIGIDA
 * Domínios genéricos com todas as funcionalidades
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
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId } = params;
    
    console.log(`🚀 [ATOMICAT] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo AtomiCat...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Se for compra manual, processar diretamente
    if (domainManual) {
      console.log(`🔍 [MANUAL-ATOMICAT] Processando domínio manual: ${domainManual}`);
      
      // Verificar disponibilidade
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
        
        // Salvar no banco e notificar
        await this.saveDomainToSupabase(domainManual, userId);
        await this.sendWhatsAppNotification(domainManual, 'success');
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
            
            // VERIFICAR DISPONIBILIDADE
            console.log(`🔍 [ATOMICAT] Verificando: ${generatedDomain}`);
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
              
              console.log(`✅ Domínio comprado: ${domain}`);
              
              // SALVAR NO BANCO COM USER_ID
              const savedDomain = await this.saveDomainToSupabase(domain, userId);
              
              // REGISTRAR NO LOG
              if (savedDomain?.domain_id) {
                await this.saveActivityLog(savedDomain.domain_id, userId);
              }
              
              // NOTIFICAR WHATSAPP
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
          console.error(`❌ Não foi possível comprar o domínio ${i + 1}`);
        }
      }
    }
    
    // Callback final
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) AtomiCat comprado(s) com sucesso!`, 
        domainsToRegister[domainsToRegister.length - 1]);
    } else {
      await this.updateProgress(sessionId, 'completed', 'error', 
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
   * GERAR DOMÍNIO GENÉRICO COM IA
   */
  async generateGenericDomainWithAI(nicho, idioma, isRetry = false) {
    const prompt = this.buildAtomiCatPrompt(nicho, idioma, isRetry);
    
    try {
      const response = await axios.post(this.openaiAPI, {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em criação de domínios genéricos para múltiplos usos.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: isRetry ? 0.95 : 0.8,
        max_tokens: 200,
        response_format: { type: "json_object" }
      }, {
        headers: {
          'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      const result = JSON.parse(response.data.choices[0].message.content);
      const domain = result.domains[0];
      
      console.log(`✅ [AI-ATOMICAT] Domínio genérico: ${domain}`);
      return domain;
      
    } catch (error) {
      console.error('❌ [AI-ATOMICAT] Erro:', error.message);
      const randomNum = Math.floor(Math.random() * 99999);
      const genericWords = ['mega', 'super', 'ultra', 'power', 'pro', 'max', 'plus'];
      const randomWord = genericWords[Math.floor(Math.random() * genericWords.length)];
      return `${randomWord}${nicho.toLowerCase().replace(/\s+/g, '')}${randomNum}.online`;
    }
  }

  /**
   * CONSTRUIR PROMPT ATOMICAT
   */
  buildAtomiCatPrompt(nicho, idioma, isRetry) {
    const idiomaMap = {
      'portuguese': 'português',
      'english': 'inglês',
      'spanish': 'espanhol',
      'german': 'alemão',
      'french': 'francês'
    };
    
    const lang = idiomaMap[idioma] || 'português';
    
    let prompt = `
    Gere um nome de domínio GENÉRICO seguindo EXATAMENTE estas regras:
    1. Use SEMPRE a extensão .online
    2. Use SEMPRE exatamente 3 palavras juntas
    3. NUNCA use acentos, cedilha, traços ou caracteres especiais
    4. O domínio deve ser em ${lang}
    5. Relacionado ao nicho: ${nicho}
    6. IMPORTANTE: O domínio deve ser GENÉRICO para múltiplos produtos
    7. Use palavras como: mega, super, top, melhor, oferta, promo, loja, shop, store
    8. Seja criativo mas mantenha o aspecto comercial genérico
    
    Retorne APENAS um JSON no formato:
    {"domains": ["dominio.online"]}
    `;
    
    if (isRetry) {
      prompt += '\n\nSeja EXTREMAMENTE criativo e use combinações ÚNICAS.';
    }
    
    return prompt;
  }

  /**
   * VERIFICAR DISPONIBILIDADE
   */
  async checkDomainAvailability(domain) {
    try {
      const clientIP = config.NAMECHEAP_CLIENT_IP;
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.check',
        ClientIp: clientIP,
        DomainList: domain
      };
      
      const response = await axios.get(this.namecheapAPI, { params });
      const xmlData = response.data;
      
      if (xmlData.includes('Status="ERROR"')) {
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        const errorMessage = errorMatch ? errorMatch[1] : 'Erro desconhecido';
        
        if (errorMessage.includes('Too many requests') || errorMessage.includes('rate limit')) {
          console.warn('⚠️ Rate limit atingido, aguardando...');
          await this.delay(5000);
          return { available: false, error: 'rate_limit' };
        }
        
        return { available: false, error: errorMessage };
      }
      
      const availableMatch = xmlData.match(/Available="([^"]+)"/);
      const isAvailable = availableMatch && availableMatch[1] === 'true';
      
      let price = 0.99;
      const isPremiumMatch = xmlData.match(/IsPremiumName="([^"]+)"/);
      if (isPremiumMatch && isPremiumMatch[1] === 'true') {
        const priceMatch = xmlData.match(/PremiumRegistrationPrice="([^"]+)"/);
        if (priceMatch) price = parseFloat(priceMatch[1]);
      }
      
      console.log(`📊 [ATOMICAT] ${domain} - Disponível: ${isAvailable ? 'SIM' : 'NÃO'} - Preço: $${price}`);
      
      return { available: isAvailable, price: price };
      
    } catch (error) {
      console.error('❌ Erro ao verificar:', error.message);
      return { available: false, error: error.message };
    }
  }

  /**
   * COMPRAR DOMÍNIO NAMECHEAP
   */
  async purchaseDomainNamecheap(domain) {
    try {
      const clientIP = config.NAMECHEAP_CLIENT_IP;
      
      console.log(`💳 [NAMECHEAP-ATOMICAT] Comprando ${domain} com IP: ${clientIP}`);
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: clientIP,
        DomainName: domain,
        Years: 1,
        
        // Dados do registrante
        AuxBillingFirstName: this.registrantInfo.FirstName,
        AuxBillingLastName: this.registrantInfo.LastName,
        AuxBillingAddress1: this.registrantInfo.Address1,
        AuxBillingCity: this.registrantInfo.City,
        AuxBillingStateProvince: this.registrantInfo.StateProvince,
        AuxBillingPostalCode: this.registrantInfo.PostalCode,
        AuxBillingCountry: this.registrantInfo.Country,
        AuxBillingPhone: this.registrantInfo.Phone,
        AuxBillingEmailAddress: this.registrantInfo.EmailAddress,
        AuxBillingOrganizationName: this.registrantInfo.OrganizationName,
        
        // Tech Contact
        TechFirstName: this.registrantInfo.FirstName,
        TechLastName: this.registrantInfo.LastName,
        TechAddress1: this.registrantInfo.Address1,
        TechCity: this.registrantInfo.City,
        TechStateProvince: this.registrantInfo.StateProvince,
        TechPostalCode: this.registrantInfo.PostalCode,
        TechCountry: this.registrantInfo.Country,
        TechPhone: this.registrantInfo.Phone,
        TechEmailAddress: 'lerricke.nunes@gmail.com',
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
      
      const response = await axios.get(this.namecheapAPI, { params });
      const xmlData = response.data;
      
      if (xmlData.includes('Status="ERROR"') || xmlData.includes('<Error')) {
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        const errorMessage = errorMatch ? errorMatch[1] : 'Erro desconhecido';
        return { success: false, error: errorMessage };
      }
      
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        console.log(`✅ [ATOMICAT] Domínio ${domain} comprado!`);
        return { success: true, domain: domain };
      }
      
      return { success: false, error: 'Resposta inesperada' };
      
    } catch (error) {
      console.error(`❌ Erro na compra:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * SALVAR DOMÍNIO NO SUPABASE
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
        p_dns_configured: false,
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
          new_value: 'Domínio comprado com IA - AtomiCat'
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
      
      // Data formatada pt-BR
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
        }
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
      
      const response = await axios.get(this.namecheapAPI, { params });
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
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AtomiCatDomainPurchase;