/**
 * COMPRA DE DOMÍNIOS ATOMICAT - LÓGICA COMPLETA
 * Este arquivo contém toda a lógica de compra de domínios para AtomiCat
 * Domínios genéricos sem instalação de WordPress
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
    this.priceLimit = 1.00; // Limite de preço em USD
    
    // Dados de contato para registro de domínios (mesmos do WordPress)
    this.registrantInfo = {
      FirstName: 'Gabriel',
      LastName: 'Gomes',
      Address1: 'Rua Lambari Nanuque',
      City: 'Belo Horizonte',
      StateProvince: 'MG',
      PostalCode: '31744016',
      Country: 'BR',
      Phone: '+55.31999999999',
      EmailAddress: 'gabrielbngomes0987@gmail.com'
    };
  }

  /**
   * FUNÇÃO PRINCIPAL - ORQUESTRA TODO O PROCESSO DE COMPRA ATOMICAT
   * Versão simplificada sem WordPress e Cloudflare
   * @param {Object} params - Parâmetros de compra
   * @returns {Object} - Resultado da compra
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId } = params;
    
    console.log(`🚀 [ATOMICAT] Iniciando compra - Quantidade: ${quantidade}, Nicho: ${nicho}`);
    
    // Callback inicial - Iniciando processo
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo de compra AtomiCat...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Loop para comprar a quantidade solicitada de domínios
    for (let i = 0; i < quantidade; i++) {
      let domain = null;
      let retries = 0;
      
      // Loop de tentativas até conseguir um domínio válido
      while (!domain && retries < this.maxRetries) {
        try {
          // ETAPA 1: GERAR DOMÍNIO GENÉRICO COM IA
          console.log(`🤖 [ATOMICAT] Gerando domínio genérico ${i + 1}/${quantidade} - Tentativa ${retries + 1}`);
          await this.updateProgress(sessionId, 'generating', 'in_progress', 
            `Gerando domínio genérico com IA... (Tentativa ${retries + 1})`);
          
          const generatedDomain = await this.generateGenericDomainWithAI(nicho, idioma, retries > 0);
          
          // ETAPA 2: VERIFICAR DISPONIBILIDADE
          console.log(`🔍 [ATOMICAT] Verificando disponibilidade: ${generatedDomain}`);
          await this.updateProgress(sessionId, 'checking', 'in_progress', 
            `Verificando disponibilidade de ${generatedDomain}...`);
          
          const isAvailable = await this.checkDomainAvailability(generatedDomain);
          
          if (!isAvailable) {
            console.log(`❌ [ATOMICAT] Domínio indisponível: ${generatedDomain}`);
            retries++;
            await this.delay(1000);
            continue;
          }
          
          // ETAPA 3: VERIFICAR PREÇO
          console.log(`💰 [ATOMICAT] Verificando preço: ${generatedDomain}`);
          await this.updateProgress(sessionId, 'searching', 'in_progress', 
            `Verificando preço de ${generatedDomain}...`);
          
          const price = await this.checkDomainPrice(generatedDomain);
          
          if (price > this.priceLimit) {
            console.log(`💸 [ATOMICAT] Domínio muito caro: $${price}`);
            await this.updateProgress(sessionId, 'searching', 'in_progress', 
              `Buscando domínio mais barato... (Preço atual: $${price})`);
            retries++;
            await this.delay(1000);
            continue;
          }
          
          // ETAPA 4: COMPRAR DOMÍNIO
          console.log(`💳 [ATOMICAT] Comprando domínio: ${generatedDomain}`);
          await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
            `Comprando ${generatedDomain}...`);
          
          const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain);
          
          if (purchaseResult.success) {
            domain = generatedDomain;
            domainsToRegister.push(domain);
            successCount++;
            
            // ETAPA 5: SALVAR NO BANCO DE DADOS
            await this.saveDomainToDatabase(domain);
            
            // ETAPA 6: NOTIFICAR VIA WHATSAPP
            await this.sendWhatsAppNotification(domain, 'success');
            
            console.log(`✅ [ATOMICAT] Domínio ${successCount}/${quantidade} comprado com sucesso: ${domain}`);
            
          } else {
            console.error(`❌ [ATOMICAT] Erro na compra: ${purchaseResult.error}`);
            
            // Se o erro for específico, tentar gerar novo domínio
            if (purchaseResult.error.includes('ERROR')) {
              retries++;
              await this.delay(2000);
            }
          }
          
        } catch (error) {
          console.error(`❌ [ATOMICAT] Erro na tentativa ${retries + 1}:`, error.message);
          retries++;
          await this.delay(2000);
        }
      }
      
      if (!domain) {
        console.error(`❌ [ATOMICAT] Não foi possível comprar o domínio ${i + 1} após ${this.maxRetries} tentativas`);
        await this.updateProgress(sessionId, 'error', 'error', 
          `Falha ao comprar domínio ${i + 1} após ${this.maxRetries} tentativas`);
      }
    }
    
    // Callback final - Processo concluído
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) AtomiCat comprado(s) com sucesso!`, 
        domainsToRegister[domainsToRegister.length - 1]);
    } else {
      await this.updateProgress(sessionId, 'completed', 'error', 
        'Nenhum domínio foi comprado com sucesso');
    }
    
    return {
      success: successCount > 0,
      domainsRegistered: domainsToRegister,
      totalRequested: quantidade,
      totalRegistered: successCount
    };
  }

  /**
   * GERAR DOMÍNIO GENÉRICO COM OPENAI (GPT)
   * Para AtomiCat, os domínios são mais genéricos e podem ser usados para múltiplos produtos
   */
  async generateGenericDomainWithAI(nicho, idioma, isRetry = false) {
    const prompt = this.buildAtomiCatPrompt(nicho, idioma, isRetry);
    
    try {
      const response = await axios.post(this.openaiAPI, {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em criação de domínios genéricos para múltiplos usos. Sempre responda apenas com JSON válido.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: isRetry ? 0.95 : 0.8, // Mais criatividade para AtomiCat
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
      
      console.log(`✅ [AI-ATOMICAT] Domínio genérico gerado: ${domain}`);
      return domain;
      
    } catch (error) {
      console.error('❌ [AI-ATOMICAT] Erro ao gerar domínio:', error.message);
      // Fallback: gerar domínio genérico básico
      const randomNum = Math.floor(Math.random() * 99999);
      const genericWords = ['mega', 'super', 'ultra', 'power', 'pro', 'max', 'plus'];
      const randomWord = genericWords[Math.floor(Math.random() * genericWords.length)];
      return `${randomWord}${nicho.toLowerCase().replace(/\s+/g, '')}${randomNum}.online`;
    }
  }

  /**
   * CONSTRUIR PROMPT ESPECÍFICO PARA ATOMICAT
   * Regras para domínios genéricos que podem ser usados para múltiplos produtos
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
    2. Use SEMPRE exatamente 3 palavras juntas (exemplo: megaofertasonline.online)
    3. NUNCA use acentos, cedilha, traços ou caracteres especiais
    4. O domínio deve ser em ${lang}
    5. Relacionado ao nicho: ${nicho}
    6. IMPORTANTE: O domínio deve ser GENÉRICO o suficiente para ser usado em MÚLTIPLOS produtos
    7. Use palavras como: mega, super, top, melhor, oferta, promo, loja, shop, store, deal, outlet
    8. Seja criativo mas mantenha o aspecto comercial genérico
    
    IMPORTANTE PARA ATOMICAT: O domínio NÃO deve ser específico demais. 
    Deve poder ser usado para vender VÁRIOS produtos diferentes.
    
    Retorne APENAS um JSON no formato:
    {"domains": ["dominio.online"]}
    `;
    
    if (isRetry) {
      prompt += '\n\nIMPORTANTE: Seja EXTREMAMENTE criativo e use combinações ÚNICAS. Evite palavras óbvias.';
    }
    
    return prompt;
  }

  /**
   * VERIFICAR DISPONIBILIDADE DO DOMÍNIO
   * Usa API Namecheap para verificar se domínio está disponível
   */
  async checkDomainAvailability(domain) {
    try {
      const clientIP = await this.getClientIP();
      
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
      
      // Verificar rate limit
      if (xmlData.includes('Too many requests') || xmlData.includes('rate limit')) {
        console.warn('⚠️ [NAMECHEAP] Rate limit atingido, aguardando...');
        await this.delay(5000);
        return false;
      }
      
      // Parse do XML para verificar disponibilidade
      const availableMatch = xmlData.match(/Available="([^"]+)"/);
      const isAvailable = availableMatch?.[1] === 'true';
      
      return isAvailable;
      
    } catch (error) {
      console.error('❌ [NAMECHEAP] Erro ao verificar disponibilidade:', error.message);
      return false;
    }
  }

  /**
   * VERIFICAR PREÇO DO DOMÍNIO
   * Verifica se o preço está dentro do limite estabelecido ($1)
   */
  async checkDomainPrice(domain) {
    try {
      const clientIP = await this.getClientIP();
      
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
      
      // Verificar se é domínio premium
      const isPremiumMatch = xmlData.match(/IsPremiumName="([^"]+)"/);
      const isPremium = isPremiumMatch?.[1] === 'true';
      
      if (isPremium) {
        const premiumPriceMatch = xmlData.match(/PremiumRegistrationPrice="([^"]+)"/);
        if (premiumPriceMatch) {
          const premiumPrice = parseFloat(premiumPriceMatch[1]);
          console.log(`💎 [ATOMICAT] Domínio premium detectado: $${premiumPrice}`);
          return premiumPrice;
        }
      }
      
      // Preço padrão para domínios .online não premium
      return 0.99;
      
    } catch (error) {
      console.error('❌ [NAMECHEAP] Erro ao verificar preço:', error.message);
      return 999; // Retorna preço alto para evitar compra em caso de erro
    }
  }

  /**
   * COMPRAR DOMÍNIO NA NAMECHEAP
   * Executa a compra efetiva do domínio para AtomiCat
   */
  async purchaseDomainNamecheap(domain) {
    try {
      const clientIP = await this.getClientIP();
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: clientIP,
        DomainName: domain,
        Years: 1,
        
        // Informações do registrante (AuxBilling)
        AuxBillingFirstName: this.registrantInfo.FirstName,
        AuxBillingLastName: this.registrantInfo.LastName,
        AuxBillingAddress1: this.registrantInfo.Address1,
        AuxBillingCity: this.registrantInfo.City,
        AuxBillingStateProvince: this.registrantInfo.StateProvince,
        AuxBillingPostalCode: this.registrantInfo.PostalCode,
        AuxBillingCountry: this.registrantInfo.Country,
        AuxBillingPhone: this.registrantInfo.Phone,
        AuxBillingEmailAddress: this.registrantInfo.EmailAddress,
        
        // Tech Contact (email diferente para AtomiCat)
        TechFirstName: this.registrantInfo.FirstName,
        TechLastName: this.registrantInfo.LastName,
        TechAddress1: this.registrantInfo.Address1,
        TechCity: this.registrantInfo.City,
        TechStateProvince: this.registrantInfo.StateProvince,
        TechPostalCode: this.registrantInfo.PostalCode,
        TechCountry: this.registrantInfo.Country,
        TechPhone: this.registrantInfo.Phone,
        TechEmailAddress: 'lerricke.nunes@gmail.com',
        
        // Admin Contact (igual ao AuxBilling)
        AdminFirstName: this.registrantInfo.FirstName,
        AdminLastName: this.registrantInfo.LastName,
        AdminAddress1: this.registrantInfo.Address1,
        AdminCity: this.registrantInfo.City,
        AdminStateProvince: this.registrantInfo.StateProvince,
        AdminPostalCode: this.registrantInfo.PostalCode,
        AdminCountry: this.registrantInfo.Country,
        AdminPhone: this.registrantInfo.Phone,
        AdminEmailAddress: this.registrantInfo.EmailAddress,
        
        // Registrant Contact (igual ao AuxBilling)
        RegistrantFirstName: this.registrantInfo.FirstName,
        RegistrantLastName: this.registrantInfo.LastName,
        RegistrantAddress1: this.registrantInfo.Address1,
        RegistrantCity: this.registrantInfo.City,
        RegistrantStateProvince: this.registrantInfo.StateProvince,
        RegistrantPostalCode: this.registrantInfo.PostalCode,
        RegistrantCountry: this.registrantInfo.Country,
        RegistrantPhone: this.registrantInfo.Phone,
        RegistrantEmailAddress: this.registrantInfo.EmailAddress,
        
        // Configurações adicionais
        AddFreeWhoisguard: 'no',
        WGEnabled: 'no',
        IsPremiumDomain: 'False'
      };
      
      const response = await axios.get(this.namecheapAPI, { params });
      const xmlData = response.data;
      
      // Verificar se há erro na resposta
      if (xmlData.includes('<Error')) {
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        const errorMessage = errorMatch?.[1] || 'Erro desconhecido na compra';
        
        console.error(`❌ [NAMECHEAP-ATOMICAT] Erro na compra: ${errorMessage}`);
        
        return {
          success: false,
          error: errorMessage
        };
      }
      
      // Extrair o nome do domínio da resposta de sucesso
      const domainMatch = xmlData.match(/Domain="([^"]+)"/);
      const purchasedDomain = domainMatch?.[1] || domain;
      
      console.log(`✅ [NAMECHEAP-ATOMICAT] Domínio comprado com sucesso: ${purchasedDomain}`);
      
      return {
        success: true,
        domain: purchasedDomain
      };
      
    } catch (error) {
      console.error('❌ [NAMECHEAP-ATOMICAT] Erro ao comprar domínio:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * SALVAR DOMÍNIO NO BANCO DE DADOS
   * Registra o domínio AtomiCat no Supabase
   */
  async saveDomainToDatabase(domain) {
    try {
      const domainData = {
        domain_name: domain,
        status: 'active',
        creation_date: new Date().toISOString(),
        expiration_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        platform: 'atomicat', // Plataforma AtomiCat
        auto_renew: false,
        whois_guard: false,
        notes: 'Domínio genérico para múltiplos produtos'
      };
      
      // Salvar na tabela domain_stats
      const { data, error } = await supabase
        .from('domain_stats')
        .upsert(domainData, { onConflict: 'domain_name' })
        .select()
        .single();
      
      if (error) {
        console.error('❌ [DATABASE-ATOMICAT] Erro ao salvar domínio:', error);
      } else {
        console.log('✅ [DATABASE-ATOMICAT] Domínio salvo no banco');
      }
      
      // Registrar log de atividade específico para AtomiCat
      await supabase
        .from('domain_activity_logs')
        .insert({
          domain_name: domain,
          action_type: 'created',
          details: {
            platform: 'atomicat',
            created_via: 'ai_purchase',
            type: 'generic_domain'
          },
          created_at: new Date().toISOString()
        });
      
      return data;
      
    } catch (error) {
      console.error('❌ [DATABASE-ATOMICAT] Erro ao salvar:', error.message);
      return null;
    }
  }

  /**
   * ENVIAR NOTIFICAÇÃO WHATSAPP
   * Notifica via Z-API sobre o status da compra AtomiCat
   */
  async sendWhatsAppNotification(domain, status) {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ [WHATSAPP-ATOMICAT] Z-API não configurado');
      return;
    }
    
    try {
      const phoneNumber = config.WHATSAPP_PHONE_NUMBER || '5531999999999';
      const currentDate = new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
      });
      
      let message;
      if (status === 'success') {
        message = `🚀 *Novo Domínio AtomiCat Comprado!*

📌 *Domínio:* ${domain}
🎯 *Tipo:* AtomiCat (Genérico)
🌐 *URL:* https://${domain}
📅 *Data:* ${currentDate}
✅ *Status:* Compra realizada com sucesso

🎨 Domínio genérico pronto para múltiplos usos!
Ideal para campanhas e produtos variados.

_Sistema DomainHub - AtomiCat_`;
      } else {
        message = `❌ *Erro na Compra AtomiCat*

📌 *Domínio tentado:* ${domain}
🎯 *Tipo:* AtomiCat
📅 *Data:* ${currentDate}
⚠️ *Status:* ${status}

Por favor, verifique o sistema.

_Sistema DomainHub - AtomiCat_`;
      }
      
      // Enviar mensagem via Z-API
      const zapiUrl = `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}/send-text`;
      
      const response = await axios.post(zapiUrl, {
        phone: phoneNumber.replace(/\D/g, ''),
        message: message
      });
      
      console.log('✅ [WHATSAPP-ATOMICAT] Notificação enviada');
      
    } catch (error) {
      console.error('❌ [WHATSAPP-ATOMICAT] Erro ao enviar notificação:', error.message);
    }
  }

  /**
   * ATUALIZAR PROGRESSO (CALLBACKS)
   * Atualiza o progresso no Supabase para o frontend acompanhar em tempo real
   */
  async updateProgress(sessionId, step, status, message, domainName = null) {
    try {
      const updateData = {
        session_id: sessionId,
        step: step,
        status: status,
        message: message,
        domain_name: domainName,
        platform: 'atomicat', // Identificar como AtomiCat
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabase
        .from('domain_purchase_progress')
        .upsert(updateData, { onConflict: 'session_id' });
      
      if (error) {
        console.error('❌ [CALLBACK-ATOMICAT] Erro ao atualizar progresso:', error);
      } else {
        console.log(`📊 [CALLBACK-ATOMICAT] Progresso atualizado: ${step} - ${status}`);
      }
      
    } catch (error) {
      console.error('❌ [CALLBACK-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * OBTER IP DO CLIENTE
   * Helper para obter IP necessário para API Namecheap
   */
  async getClientIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json');
      return response.data.ip;
    } catch (error) {
      console.error('⚠️ [IP] Erro ao obter IP, usando fallback');
      return '127.0.0.1';
    }
  }

  /**
   * DELAY HELPER
   * Função auxiliar para aguardar entre requisições
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * VERIFICAR SALDO NAMECHEAP
   * Verifica se há saldo suficiente para comprar domínios
   */
  async checkBalance() {
    try {
      const clientIP = await this.getClientIP();
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.users.getBalances',
        ClientIp: clientIP
      };
      
      const response = await axios.get(this.namecheapAPI, { params });
      const xmlData = response.data;
      
      // Parse do saldo
      const balanceMatch = xmlData.match(/Balance="([^"]+)"/);
      const balance = balanceMatch ? parseFloat(balanceMatch[1]) : 0;
      
      console.log(`💰 [ATOMICAT] Saldo Namecheap: $${balance}`);
      
      return balance;
      
    } catch (error) {
      console.error('❌ [ATOMICAT] Erro ao verificar saldo:', error.message);
      return 0;
    }
  }
}

module.exports = AtomiCatDomainPurchase;
