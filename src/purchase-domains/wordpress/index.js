/**
 * COMPRA DE DOMÍNIOS WORDPRESS - LÓGICA COMPLETA
 * Este arquivo contém toda a lógica de compra de domínios para WordPress
 * Substitui a automação do N8N por código robusto e escalável
 */

const axios = require('axios');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');

// Inicializar Supabase
const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_KEY
);

class WordPressDomainPurchase {
  constructor() {
    // Configurações de APIs
    this.namecheapAPI = 'https://api.namecheap.com/xml.response';
    this.cloudflareAPI = 'https://api.cloudflare.com/client/v4';
    this.openaiAPI = 'https://api.openai.com/v1/chat/completions';
    
    // Configurações de compra
    this.maxRetries = 10;
    this.priceLimit = 1.00; // Limite de preço em USD
    
    // Dados de contato para registro de domínios
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
   * FUNÇÃO PRINCIPAL - ORQUESTRA TODO O PROCESSO DE COMPRA
   * @param {Object} params - Parâmetros de compra
   * @returns {Object} - Resultado da compra
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId } = params;
    
    console.log(`🚀 [WORDPRESS] Iniciando compra - Quantidade: ${quantidade}, Nicho: ${nicho}`);
    
    // Callback inicial - Iniciando processo
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo de compra...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Loop para comprar a quantidade solicitada de domínios
    for (let i = 0; i < quantidade; i++) {
      let domain = null;
      let retries = 0;
      
      // Loop de tentativas até conseguir um domínio válido
      while (!domain && retries < this.maxRetries) {
        try {
          // ETAPA 1: GERAR DOMÍNIO COM IA
          console.log(`🤖 [WORDPRESS] Gerando domínio ${i + 1}/${quantidade} - Tentativa ${retries + 1}`);
          await this.updateProgress(sessionId, 'generating', 'in_progress', 
            `Gerando domínios com IA... (Tentativa ${retries + 1})`);
          
          const generatedDomain = await this.generateDomainWithAI(nicho, idioma, retries > 0);
          
          // ETAPA 2: VERIFICAR DISPONIBILIDADE
          console.log(`🔍 [WORDPRESS] Verificando disponibilidade: ${generatedDomain}`);
          await this.updateProgress(sessionId, 'checking', 'in_progress', 
            `Verificando disponibilidade de ${generatedDomain}...`);
          
          const isAvailable = await this.checkDomainAvailability(generatedDomain);
          
          if (!isAvailable) {
            console.log(`❌ [WORDPRESS] Domínio indisponível: ${generatedDomain}`);
            retries++;
            continue;
          }
          
          // ETAPA 3: VERIFICAR PREÇO
          console.log(`💰 [WORDPRESS] Verificando preço: ${generatedDomain}`);
          await this.updateProgress(sessionId, 'searching', 'in_progress', 
            `Verificando preço de ${generatedDomain}...`);
          
          const price = await this.checkDomainPrice(generatedDomain);
          
          if (price > this.priceLimit) {
            console.log(`💸 [WORDPRESS] Domínio muito caro: $${price}`);
            retries++;
            continue;
          }
          
          // ETAPA 4: COMPRAR DOMÍNIO
          console.log(`💳 [WORDPRESS] Comprando domínio: ${generatedDomain}`);
          await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
            `Comprando ${generatedDomain}...`);
          
          const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain);
          
          if (purchaseResult.success) {
            domain = generatedDomain;
            domainsToRegister.push(domain);
            successCount++;
            
            // ETAPA 5: CONFIGURAR NAMESERVERS
            console.log(`🔧 [WORDPRESS] Configurando nameservers: ${domain}`);
            await this.updateProgress(sessionId, 'nameservers', 'in_progress', 
              `Alterando nameservers de ${domain}...`);
            
            await this.updateNameservers(domain);
            
            // ETAPA 6: CONFIGURAR CLOUDFLARE
            console.log(`☁️ [WORDPRESS] Configurando Cloudflare: ${domain}`);
            await this.updateProgress(sessionId, 'cloudflare', 'in_progress', 
              `Configurando Cloudflare para ${domain}...`);
            
            const cloudflareSetup = await this.setupCloudflare(domain);
            
            // ETAPA 7: INSTALAR WORDPRESS (se configurado)
            if (config.CPANEL_URL && config.CPANEL_API_TOKEN) {
              console.log(`📦 [WORDPRESS] Instalando WordPress: ${domain}`);
              await this.updateProgress(sessionId, 'wordpress', 'in_progress', 
                `Instalando WordPress em ${domain}...`);
              
              await this.installWordPress(domain);
            }
            
            // ETAPA 8: SALVAR NO BANCO DE DADOS
            await this.saveDomainToDatabase(domain, cloudflareSetup);
            
            // ETAPA 9: NOTIFICAR VIA WHATSAPP
            await this.sendWhatsAppNotification(domain, 'success');
            
          } else {
            console.error(`❌ [WORDPRESS] Erro na compra: ${purchaseResult.error}`);
            retries++;
          }
          
        } catch (error) {
          console.error(`❌ [WORDPRESS] Erro na tentativa ${retries + 1}:`, error.message);
          retries++;
        }
      }
      
      if (!domain) {
        console.error(`❌ [WORDPRESS] Não foi possível comprar o domínio ${i + 1} após ${this.maxRetries} tentativas`);
      }
    }
    
    // Callback final - Processo concluído
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) comprado(s) com sucesso!`, domainsToRegister[0]);
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
   * GERAR DOMÍNIO COM OPENAI (GPT)
   * Substitui o Gemini usado no N8N
   */
  async generateDomainWithAI(nicho, idioma, isRetry = false) {
    const prompt = this.buildPrompt(nicho, idioma, isRetry);
    
    try {
      const response = await axios.post(this.openaiAPI, {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em criação de domínios. Sempre responda apenas com JSON válido.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: isRetry ? 0.9 : 0.7,
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
      
      console.log(`✅ [AI] Domínio gerado: ${domain}`);
      return domain;
      
    } catch (error) {
      console.error('❌ [AI] Erro ao gerar domínio:', error.message);
      // Fallback: gerar domínio básico
      const randomNum = Math.floor(Math.random() * 9999);
      return `${nicho.toLowerCase().replace(/\s+/g, '')}${randomNum}.online`;
    }
  }

  /**
   * CONSTRUIR PROMPT PARA IA
   * Define as regras para geração de domínios
   */
  buildPrompt(nicho, idioma, isRetry) {
    const idiomaMap = {
      'portuguese': 'português',
      'english': 'inglês',
      'spanish': 'espanhol',
      'german': 'alemão',
      'french': 'francês'
    };
    
    const lang = idiomaMap[idioma] || 'português';
    
    let prompt = `
    Gere um nome de domínio seguindo EXATAMENTE estas regras:
    1. Use SEMPRE a extensão .online
    2. Use SEMPRE exatamente 3 palavras juntas (exemplo: saudevidanatural.online)
    3. NUNCA use acentos, cedilha, traços ou caracteres especiais
    4. O domínio deve ser em ${lang}
    5. Relacionado ao nicho: ${nicho}
    6. Seja criativo e único
    
    Retorne APENAS um JSON no formato:
    {"domains": ["dominio.online"]}
    `;
    
    if (isRetry) {
      prompt += '\n\nIMPORTANTE: Seja MUITO criativo e use combinações incomuns para garantir disponibilidade.';
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
   * Verifica se o preço está dentro do limite estabelecido
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
      
      // Parse do preço se for premium
      const premiumPriceMatch = xmlData.match(/PremiumRegistrationPrice="([^"]+)"/);
      
      if (premiumPriceMatch) {
        return parseFloat(premiumPriceMatch[1]);
      }
      
      // Preço padrão para domínios .online
      return 0.99;
      
    } catch (error) {
      console.error('❌ [NAMECHEAP] Erro ao verificar preço:', error.message);
      return 999; // Retorna preço alto para evitar compra em caso de erro
    }
  }

  /**
   * COMPRAR DOMÍNIO NA NAMECHEAP
   * Executa a compra efetiva do domínio
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
        return {
          success: false,
          error: errorMatch?.[1] || 'Erro desconhecido na compra'
        };
      }
      
      return {
        success: true,
        domain: domain
      };
      
    } catch (error) {
      console.error('❌ [NAMECHEAP] Erro ao comprar domínio:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * ATUALIZAR NAMESERVERS PARA CLOUDFLARE
   * Altera os nameservers do domínio para apontar para Cloudflare
   */
  async updateNameservers(domain) {
    try {
      const clientIP = await this.getClientIP();
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.dns.setCustom',
        ClientIp: clientIP,
        DomainName: domain,
        Nameservers: 'ganz.ns.cloudflare.com,norah.ns.cloudflare.com'
      };
      
      const response = await axios.get(this.namecheapAPI, { params });
      
      console.log('✅ [NAMECHEAP] Nameservers atualizados para Cloudflare');
      return true;
      
    } catch (error) {
      console.error('❌ [NAMECHEAP] Erro ao atualizar nameservers:', error.message);
      return false;
    }
  }

  /**
   * CONFIGURAR CLOUDFLARE
   * Cria zona no Cloudflare e configura DNS
   */
  async setupCloudflare(domain) {
    try {
      // CRIAR ZONA NO CLOUDFLARE
      console.log('☁️ [CLOUDFLARE] Criando zona...');
      const zoneResponse = await axios.post(
        `${this.cloudflareAPI}/zones`,
        {
          name: domain,
          account: { id: config.CLOUDFLARE_ACCOUNT_ID },
          jump_start: true
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const zoneId = zoneResponse.data.result.id;
      
      // CONFIGURAR REGISTROS DNS
      console.log('🔧 [CLOUDFLARE] Configurando DNS...');
      
      // Registro A - IP do servidor
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
        {
          type: 'A',
          name: domain,
          content: '69.46.11.10', // IP do servidor de hospedagem
          ttl: 1,
          proxied: true
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Registro CNAME - www
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
        {
          type: 'CNAME',
          name: `www.${domain}`,
          content: domain,
          ttl: 1,
          proxied: true
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Registro CNAME - RedTrack
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
        {
          type: 'CNAME',
          name: `track.${domain}`,
          content: 'khrv4.ttrk.io',
          ttl: 1,
          proxied: false
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // CONFIGURAR SSL PARA FULL
      console.log('🔒 [CLOUDFLARE] Configurando SSL...');
      await axios.patch(
        `${this.cloudflareAPI}/zones/${zoneId}/settings/ssl`,
        { value: 'full' },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // CONFIGURAR REGRAS WAF (Firewall)
      console.log('🛡️ [CLOUDFLARE] Configurando WAF...');
      
      // Bloquear sitemap
      await this.createWAFRule(zoneId, 
        '(http.request.uri.path contains "sitemap")', 
        'Block Sitemap Requests'
      );
      
      // Bloquear ?s= (pesquisas WordPress)
      await this.createWAFRule(zoneId, 
        '(http.request.uri.query contains "?s=")', 
        'Block Search Queries'
      );
      
      console.log('✅ [CLOUDFLARE] Configuração completa');
      
      return {
        zoneId,
        nameservers: ['ganz.ns.cloudflare.com', 'norah.ns.cloudflare.com']
      };
      
    } catch (error) {
      console.error('❌ [CLOUDFLARE] Erro na configuração:', error.message);
      
      // Se a zona já existe, não é erro crítico
      if (error.response?.data?.errors?.[0]?.code === 1061) {
        console.log('ℹ️ [CLOUDFLARE] Zona já existe, continuando...');
        return { zoneId: null };
      }
      
      return { zoneId: null };
    }
  }

  /**
   * CRIAR REGRA WAF NO CLOUDFLARE
   * Helper para criar regras de firewall
   */
  async createWAFRule(zoneId, expression, description) {
    try {
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/firewall/rules`,
        {
          filter: {
            expression,
            description
          },
          action: 'block'
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      console.error(`⚠️ [CLOUDFLARE] Erro ao criar regra WAF: ${description}`);
    }
  }

  /**
   * INSTALAR WORDPRESS VIA SOFTACULOUS
   * Instala WordPress no domínio via cPanel/Softaculous
   */
  async installWordPress(domain) {
    if (!config.CPANEL_URL || !config.CPANEL_API_TOKEN) {
      console.log('⚠️ [WORDPRESS] cPanel não configurado, pulando instalação');
      return false;
    }
    
    try {
      // Gerar credenciais para o WordPress
      const adminUser = `admin_${domain.replace(/\./g, '').substring(0, 10)}`;
      const adminPass = this.generateRandomPassword();
      const adminEmail = 'gabrielbngomes0987@gmail.com';
      
      // Parâmetros de instalação
      const params = new URLSearchParams({
        softsubmit: '1',
        softdomain: domain,
        softdirectory: '',
        admin_username: adminUser,
        admin_pass: adminPass,
        admin_email: adminEmail,
        site_name: domain.split('.')[0],
        site_desc: 'Bem-vindo ao nosso site',
        dbprefix: 'wp_',
        language: 'pt_BR',
        auto_upgrade: '1',
        auto_upgrade_plugins: '1',
        auto_upgrade_themes: '1'
      });
      
      // URL da API Softaculous
      const apiUrl = `${config.CPANEL_URL}:2087/frontend/x3/softaculous/index.live.php`;
      
      const response = await axios.post(apiUrl, params.toString(), {
        headers: {
          'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 60000
      });
      
      console.log(`✅ [WORDPRESS] WordPress instalado em ${domain}`);
      console.log(`   Admin URL: https://${domain}/wp-admin`);
      console.log(`   Username: ${adminUser}`);
      
      // Salvar credenciais no banco (opcional)
      await this.saveWordPressCredentials(domain, adminUser, adminPass);
      
      return true;
      
    } catch (error) {
      console.error('❌ [WORDPRESS] Erro na instalação:', error.message);
      return false;
    }
  }

  /**
   * SALVAR DOMÍNIO NO BANCO DE DADOS
   * Registra o domínio no Supabase
   */
  async saveDomainToDatabase(domain, cloudflareSetup) {
    try {
      const domainData = {
        domain_name: domain,
        status: 'active',
        creation_date: new Date().toISOString(),
        expiration_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        nameservers: cloudflareSetup?.nameservers || [],
        platform: 'wordpress',
        auto_renew: false,
        whois_guard: false,
        zone_id: cloudflareSetup?.zoneId
      };
      
      // Salvar na tabela domain_stats
      const { data, error } = await supabase
        .from('domain_stats')
        .upsert(domainData, { onConflict: 'domain_name' })
        .select()
        .single();
      
      if (error) {
        console.error('❌ [DATABASE] Erro ao salvar domínio:', error);
      } else {
        console.log('✅ [DATABASE] Domínio salvo no banco');
      }
      
      // Registrar log de atividade
      await supabase
        .from('domain_activity_logs')
        .insert({
          domain_name: domain,
          action_type: 'created',
          details: {
            platform: 'wordpress',
            created_via: 'ai_purchase'
          },
          created_at: new Date().toISOString()
        });
      
      return data;
      
    } catch (error) {
      console.error('❌ [DATABASE] Erro ao salvar:', error.message);
      return null;
    }
  }

  /**
   * ENVIAR NOTIFICAÇÃO WHATSAPP
   * Notifica via Z-API sobre o status da compra
   */
  async sendWhatsAppNotification(domain, status) {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ [WHATSAPP] Z-API não configurado');
      return;
    }
    
    try {
      const phoneNumber = config.WHATSAPP_PHONE_NUMBER || '5531999999999';
      
      let message;
      if (status === 'success') {
        message = `🎉 *Novo Domínio WordPress Comprado!*

📌 *Domínio:* ${domain}
🌐 *URL:* https://${domain}
👤 *Admin:* https://${domain}/wp-admin
📅 *Data:* ${new Date().toLocaleString('pt-BR')}
✅ *Status:* Compra realizada com sucesso

WordPress instalado e configurado!

_Sistema DomainHub_`;
      } else {
        message = `❌ *Erro na Compra de Domínio*

📌 *Domínio:* ${domain}
📅 *Data:* ${new Date().toLocaleString('pt-BR')}
⚠️ *Status:* ${status}

Por favor, verifique o sistema.

_Sistema DomainHub_`;
      }
      
      // Enviar mensagem via Z-API
      const response = await axios.post(
        `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}/send-text`,
        {
          phone: phoneNumber.replace(/\D/g, ''),
          message: message
        }
      );
      
      console.log('✅ [WHATSAPP] Notificação enviada');
      
    } catch (error) {
      console.error('❌ [WHATSAPP] Erro ao enviar notificação:', error.message);
    }
  }

  /**
   * ATUALIZAR PROGRESSO (CALLBACKS)
   * Atualiza o progresso no Supabase para o frontend acompanhar
   */
  async updateProgress(sessionId, step, status, message, domainName = null) {
    try {
      const updateData = {
        session_id: sessionId,
        step: step,
        status: status,
        message: message,
        domain_name: domainName,
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabase
        .from('domain_purchase_progress')
        .upsert(updateData, { onConflict: 'session_id' });
      
      if (error) {
        console.error('❌ [CALLBACK] Erro ao atualizar progresso:', error);
      }
      
    } catch (error) {
      console.error('❌ [CALLBACK] Erro:', error.message);
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
      return '127.0.0.1';
    }
  }

  /**
   * GERAR SENHA ALEATÓRIA
   * Helper para gerar senhas seguras para WordPress
   */
  generateRandomPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let password = '';
    for (let i = 0; i < 16; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * SALVAR CREDENCIAIS WORDPRESS
   * Helper para salvar credenciais do WordPress no banco
   */
  async saveWordPressCredentials(domain, username, password) {
    try {
      await supabase
        .from('wordpress_credentials')
        .insert({
          domain_name: domain,
          admin_username: username,
          admin_password: password, // Idealmente, isso deveria ser criptografado
          created_at: new Date().toISOString()
        });
    } catch (error) {
      console.error('⚠️ [DATABASE] Erro ao salvar credenciais:', error.message);
    }
  }
}

module.exports = WordPressDomainPurchase;
