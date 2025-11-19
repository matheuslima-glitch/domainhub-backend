/**
 * COMPRA DE DOMÍNIOS ATOMICAT - VERSÃO DEFINITIVA
 * Correções finais:
 * - Parsing correto do domínio para Namecheap
 * - Validação antes de enviar para API
 * - Logging detalhado de XML para debug
 * - Removido log de "Preço bruto da API"
 * IMPORTANTE: AtomiCat APENAS compra (sem Cloudflare/WordPress)
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
   * FUNÇÃO PRINCIPAL - APENAS COMPRA (SEM CLOUDFLARE/WORDPRESS)
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId } = params;
    
    console.log(`🚀 [ATOMICAT] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    console.log(`   ⚠️ MODO ATOMICAT: Apenas compra (sem Cloudflare/WordPress)`);
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo AtomiCat...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Se for compra manual
    if (domainManual) {
      console.log(`🔍 [MANUAL-ATOMICAT] Processando: ${domainManual}`);
      
      const availabilityCheck = await this.checkDomainAvailability(domainManual);
      
      if (!availabilityCheck.available) {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Domínio ${domainManual} não está disponível`);
        return { success: false, error: 'Domínio não disponível' };
      }
      
      if (availabilityCheck.price > this.priceLimit) {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Domínio ${domainManual} muito caro: $${availabilityCheck.price}`);
        return { success: false, error: 'Domínio muito caro' };
      }
      
      const purchaseResult = await this.purchaseDomainNamecheap(domainManual);
      
      if (purchaseResult.success) {
        domainsToRegister.push(domainManual);
        successCount = 1;
        
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
            console.log(`🤖 [AI-ATOMICAT] Gerando domínio genérico ${i + 1}/${quantidade}`);
            await this.updateProgress(sessionId, 'generating', 'in_progress', 
              `Gerando domínio genérico ${i + 1}/${quantidade}`);
            
            const generatedDomain = await this.generateGenericDomainWithAI(nicho, idioma, retries > 0);
            
            if (!generatedDomain) {
              console.error('❌ Falha ao gerar domínio');
              retries++;
              await this.delay(2000);
              continue;
            }
            
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
            
            console.log(`✅ Domínio disponível: ${generatedDomain} por $${availabilityCheck.price}`);
            
            if (availabilityCheck.price > this.priceLimit) {
              console.log(`💸 Domínio muito caro: $${availabilityCheck.price}`);
              retries++;
              await this.delay(2000);
              continue;
            }
            
            console.log(`💳 Comprando: ${generatedDomain} por $${availabilityCheck.price}`);
            await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
              `Comprando ${generatedDomain}...`);
            
            const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain);
            
            if (purchaseResult.success) {
              domain = generatedDomain;
              domainsToRegister.push(domain);
              successCount++;
              
              console.log(`✅ [ATOMICAT] Domínio comprado: ${domain}`);
              console.log(`   ⚠️ Cloudflare e WordPress NÃO configurados (modo AtomiCat)`);
              
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
          console.error(`❌ Não foi possível comprar o domínio ${i + 1}`);
        }
      }
    }
    
    // Callback final
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) AtomiCat comprado(s)!`, 
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
   */
  async checkDomainAvailability(domain) {
    if (!config.GODADDY_API_KEY || !config.GODADDY_API_SECRET) {
      console.error('❌ [GODADDY] API não configurada!');
      return { available: false, error: 'GoDaddy API não configurada' };
    }

    try {
      console.log(`🔍 [GODADDY-ATOMICAT] Verificando: ${domain}...`);
      
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
          timeout: 15000
        }
      );

      const data = response.data;
      const isAvailable = data.available === true;
      
      // Converter microdollars para dólares
      let price = 0.99;
      if (data.price && typeof data.price === 'number') {
        price = data.price / 1000000;
      }

      console.log(`📊 [GODADDY-ATOMICAT] ${domain}`);
      console.log(`   Disponível: ${isAvailable ? '✅ SIM' : '❌ NÃO'}`);
      console.log(`   Preço: $${price.toFixed(2)}`);
      
      return {
        available: isAvailable,
        price: price,
        definitive: data.definitive || false
      };

    } catch (error) {
      console.error('❌ [GODADDY-ATOMICAT] Erro:', error.message);
      
      if (error.response) {
        if (error.response.status === 401) {
          return { available: false, error: 'Autenticação GoDaddy falhou' };
        }
        if (error.response.status === 403) {
          return { available: false, error: 'Sem permissão GoDaddy' };
        }
        if (error.response.status === 404) {
          return { available: false, error: 'Domínio inválido' };
        }
      }
      
      return { available: false, error: error.message };
    }
  }

  /**
   * GERAR DOMÍNIO GENÉRICO COM IA
   */
  async generateGenericDomainWithAI(nicho, idioma, isRetry) {
    if (!config.OPENAI_API_KEY) {
      console.error('❌ OpenAI API não configurada');
      throw new Error('OpenAI API Key não configurada');
    }

    try {
      const prompt = this.buildGenericPrompt(nicho, idioma, isRetry);
      
      const response = await axios.post(
        this.openaiAPI,
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Você é um especialista em criar nomes de domínios genéricos e versáteis.' },
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
      
      let domains = [];
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      try {
        const parsed = JSON.parse(cleanContent);
        domains = parsed.domains || [];
      } catch (parseError) {
        const match = content.match(/([a-z0-9]+)\.online/i);
        if (match) {
          domains = [match[0].toLowerCase()];
        }
      }
      
      if (domains.length === 0) {
        console.error('❌ Nenhum domínio gerado');
        return null;
      }
      
      const domain = domains[0].toLowerCase().trim();
      
      if (!domain.endsWith('.online')) {
        console.error(`❌ Domínio inválido (sem .online): ${domain}`);
        return null;
      }
      
      if (!/^[a-z0-9]+\.online$/.test(domain)) {
        console.error(`❌ Domínio com caracteres inválidos: ${domain}`);
        return null;
      }
      
      console.log(`✅ [AI-ATOMICAT] Domínio gerado: ${domain}`);
      return domain;
      
    } catch (error) {
      console.error('❌ [AI-ATOMICAT] Erro:', error.message);
      throw error;
    }
  }

  /**
   * COMPRAR DOMÍNIO NA NAMECHEAP - VERSÃO CORRIGIDA
   */
  async purchaseDomainNamecheap(domain) {
    try {
      console.log(`💳 [NAMECHEAP-ATOMICAT] Comprando: ${domain}`);
      
      // Validar formato
      if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
        console.error(`❌ [NAMECHEAP] Formato inválido: ${domain}`);
        return { success: false, error: 'Formato de domínio inválido' };
      }
      
      // Validar que termina com .online
      if (!domain.endsWith('.online')) {
        console.error(`❌ [NAMECHEAP] Domínio deve terminar com .online: ${domain}`);
        return { success: false, error: 'Domínio deve terminar com .online' };
      }
      
      // Validar caracteres (apenas letras e números antes do .online)
      const domainWithoutExt = domain.replace('.online', '');
      if (!/^[a-z0-9]+$/i.test(domainWithoutExt)) {
        console.error(`❌ [NAMECHEAP] Caracteres inválidos: ${domainWithoutExt}`);
        return { success: false, error: 'Domínio com caracteres inválidos' };
      }
      
      console.log(`📝 [NAMECHEAP-ATOMICAT] Enviando domínio completo: ${domain}`);
      
      // CORREÇÃO CRÍTICA: Enviar domínio COMPLETO (como no N8N)
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        DomainName: domain,
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
      
      console.log(`📤 [NAMECHEAP-ATOMICAT] Enviando requisição...`);
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      const xmlData = response.data;
      
      console.log(`📥 [NAMECHEAP-ATOMICAT] Resposta (primeiros 500 chars):`);
      console.log(xmlData.substring(0, 500));
      
      if (xmlData.includes('Status="ERROR"')) {
        console.error(`❌ [NAMECHEAP-ATOMICAT] Status ERROR detectado`);
        
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        if (errorMatch) {
          const errorMessage = errorMatch[1];
          console.error(`❌ [NAMECHEAP-ATOMICAT] Erro: ${errorMessage}`);
          return { success: false, error: errorMessage };
        }
        
        console.error(`❌ [NAMECHEAP-ATOMICAT] XML completo:`);
        console.error(xmlData);
        return { success: false, error: 'Erro na compra - verifique logs' };
      }
      
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        console.log(`✅ [NAMECHEAP-ATOMICAT] Domínio ${domain} comprado!`);
        return { success: true, domain: domain };
      }
      
      console.error(`❌ [NAMECHEAP-ATOMICAT] Resposta inesperada`);
      console.error(`📄 [NAMECHEAP-ATOMICAT] XML completo:`);
      console.error(xmlData);
      return { success: false, error: 'Resposta inesperada' };
      
    } catch (error) {
      console.error(`❌ [NAMECHEAP-ATOMICAT] Erro:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * SALVAR NO SUPABASE (SEM NAMESERVERS)
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
        p_nameservers: null,
        p_dns_configured: false,
        p_auto_renew: false
      };
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE-ATOMICAT] Erro:', error);
        return null;
      }
      
      console.log('✅ [SUPABASE-ATOMICAT] Domínio salvo');
      
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
   * REGISTRAR LOG
   */
  async saveActivityLog(domainId, userId) {
    try {
      await supabase
        .from('domain_activity_logs')
        .insert({
          domain_id: domainId,
          user_id: userId || config.SUPABASE_USER_ID,
          action_type: 'created',
          old_value: null,
          new_value: 'Domínio comprado com IA - AtomiCat (sem WordPress)'
        });
      
      console.log('✅ [LOG-ATOMICAT] Atividade registrada');
      
    } catch (error) {
      console.error('❌ [LOG-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * NOTIFICAR WHATSAPP
   */
  async sendWhatsAppNotification(domain, status) {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
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
        message = `🚀 *DOMÍNIO ATOMICAT COMPRADO!*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `🎯 *Tipo:* AtomiCat (Genérico)\n` +
          `🌐 *URL:* https://${domain}\n` +
          `📅 *Data:* ${dataFormatada}\n` +
          `✅ *Status:* Compra realizada\n\n` +
          `⚠️ Cloudflare e WordPress NÃO configurados\n\n` +
          `_Sistema DomainHub - AtomiCat_`;
      } else {
        message = `❌ *ERRO ATOMICAT*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `📅 *Data:* ${dataFormatada}\n\n` +
          `_Sistema DomainHub - AtomiCat_`;
      }
      
      await axios.post(
        `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}/send-text`,
        { phone: phoneNumber.replace(/\D/g, ''), message: message },
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
      await supabase
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
    } catch (error) {
      console.error('❌ [PROGRESS-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * VERIFICAR SALDO
   */
  async checkBalance() {
    try {
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.users.getBalances',
        ClientIp: config.NAMECHEAP_CLIENT_IP
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
    Gere um nome de domínio GENÉRICO e VERSÁTIL:
    1. Use SEMPRE a extensão .online
    2. Use 2 ou 3 palavras juntas genéricas
    3. NUNCA use acentos, cedilha, traços
    4. Em ${lang}
    5. Inspirado em: ${nicho}
    6. Adaptável para múltiplos produtos
    
    Retorne APENAS JSON:
    {"domains": ["dominio.online"]}
    `;
    
    if (isRetry) {
      prompt += '\n\nSeja MUITO criativo.';
    }
    
    return prompt;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AtomiCatDomainPurchase;