/**
 * COMPRA DE DOMÍNIOS WORDPRESS - VERSÃO COMPLETA CORRIGIDA
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
   * FUNÇÃO PRINCIPAL - ORQUESTRA TODO O PROCESSO
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId } = params;
    
    console.log(`🚀 [WORDPRESS] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Se for compra manual, processar diretamente
    if (domainManual) {
      console.log(`🔍 [MANUAL] Processando domínio manual: ${domainManual}`);
      
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
        
        // Processar todas as configurações
        await this.processPostPurchase(domainManual, userId, sessionId);
      }
      
    } else {
      // Compra com IA
      for (let i = 0; i < quantidade; i++) {
        let domain = null;
        let retries = 0;
        
        while (!domain && retries < this.maxRetries) {
          try {
            // GERAR DOMÍNIO COM IA
            console.log(`🤖 [AI] Gerando domínio ${i + 1}/${quantidade}`);
            await this.updateProgress(sessionId, 'generating', 'in_progress', 
              `Gerando domínio ${i + 1}/${quantidade}`);
            
            const generatedDomain = await this.generateDomainWithAI(nicho, idioma, retries > 0);
            
            // VERIFICAR DISPONIBILIDADE
            console.log(`🔍 [NAMECHEAP] Verificando: ${generatedDomain}`);
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
              
              // Processar todas as configurações
              await this.processPostPurchase(domain, userId, sessionId);
            } else {
              console.error(`❌ Erro na compra: ${purchaseResult.error}`);
              retries++;
              await this.delay(3000);
            }
            
          } catch (error) {
            console.error(`❌ Erro na tentativa ${retries + 1}:`, error.message);
            retries++;
            await this.delay(3000);
          }
        }
      }
    }
    
    // Callback final
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) comprado(s) com sucesso!`, domainsToRegister[0]);
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
   * PROCESSAR PÓS-COMPRA - Todas as configurações
   */
  async processPostPurchase(domain, userId, sessionId) {
    try {
      // 1. CONFIGURAR NAMESERVERS
      console.log(`🔧 [NAMESERVERS] Alterando para Cloudflare...`);
      await this.updateProgress(sessionId, 'nameservers', 'in_progress', 
        `Alterando nameservers de ${domain}...`);
      await this.updateNameservers(domain);
      
      // 2. CONFIGURAR CLOUDFLARE COMPLETO
      console.log(`☁️ [CLOUDFLARE] Configurando zona e DNS...`);
      await this.updateProgress(sessionId, 'cloudflare', 'in_progress', 
        `Configurando Cloudflare para ${domain}...`);
      const cloudflareSetup = await this.setupCloudflareComplete(domain);
      
      // 3. ADICIONAR DOMÍNIO AO CPANEL
      console.log(`📦 [CPANEL] Adicionando domínio...`);
      await this.updateProgress(sessionId, 'cpanel', 'in_progress', 
        `Adicionando ${domain} ao cPanel...`);
      await this.addDomainToCPanel(domain);
      
      // 4. INSTALAR WORDPRESS
      console.log(`🌐 [WORDPRESS] Instalando via Softaculous...`);
      await this.updateProgress(sessionId, 'wordpress', 'in_progress', 
        `Instalando WordPress em ${domain}...`);
      await this.installWordPressSoftaculous(domain);
      
      // 5. SALVAR NO SUPABASE COM USER_ID
      console.log(`💾 [SUPABASE] Salvando domínio...`);
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup);
      
      // 6. REGISTRAR NO LOG DE ATIVIDADES
      if (savedDomain?.domain_id) {
        await this.saveActivityLog(savedDomain.domain_id, userId);
      }
      
      // 7. NOTIFICAR VIA WHATSAPP
      await this.sendWhatsAppNotification(domain, 'success');
      
      console.log(`✅ [COMPLETO] Domínio ${domain} configurado com sucesso!`);
      
    } catch (error) {
      console.error(`❌ [POST-PURCHASE] Erro:`, error.message);
      await this.sendWhatsAppNotification(domain, 'error', error.message);
    }
  }

  /**
   * GERAR DOMÍNIO COM IA
   */
  async generateDomainWithAI(nicho, idioma, isRetry = false) {
    const prompt = this.buildPrompt(nicho, idioma, isRetry);
    
    try {
      const response = await axios.post(this.openaiAPI, {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Você é um especialista em criação de domínios.' },
          { role: 'user', content: prompt }
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
      return result.domains[0];
      
    } catch (error) {
      console.error('❌ [AI] Erro:', error.message);
      const randomNum = Math.floor(Math.random() * 9999);
      return `${nicho.toLowerCase().replace(/\s+/g, '')}${randomNum}.online`;
    }
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
        return { available: false, error: errorMatch?.[1] };
      }
      
      const availableMatch = xmlData.match(/Available="([^"]+)"/);
      const isAvailable = availableMatch && availableMatch[1] === 'true';
      
      let price = 0.99;
      const isPremiumMatch = xmlData.match(/IsPremiumName="([^"]+)"/);
      if (isPremiumMatch && isPremiumMatch[1] === 'true') {
        const priceMatch = xmlData.match(/PremiumRegistrationPrice="([^"]+)"/);
        if (priceMatch) price = parseFloat(priceMatch[1]);
      }
      
      console.log(`📊 ${domain} - Disponível: ${isAvailable ? 'SIM' : 'NÃO'} - Preço: $${price}`);
      
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
        return { success: false, error: errorMatch?.[1] || 'Erro desconhecido' };
      }
      
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        console.log(`✅ Domínio ${domain} comprado!`);
        return { success: true, domain: domain };
      }
      
      return { success: false, error: 'Resposta inesperada' };
      
    } catch (error) {
      console.error(`❌ Erro na compra:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * ATUALIZAR NAMESERVERS
   */
  async updateNameservers(domain) {
    try {
      const clientIP = config.NAMECHEAP_CLIENT_IP;
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.dns.setCustom',
        ClientIp: clientIP,
        DomainName: domain,
        Nameservers: 'ganz.ns.cloudflare.com,norah.ns.cloudflare.com'
      };
      
      await axios.get(this.namecheapAPI, { params });
      console.log('✅ Nameservers atualizados');
      return true;
      
    } catch (error) {
      console.error('❌ Erro nameservers:', error.message);
      return false;
    }
  }

  /**
   * CONFIGURAR CLOUDFLARE COMPLETO
   */
  async setupCloudflareComplete(domain) {
    try {
      // CRIAR ZONA
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
      console.log(`✅ Zona criada: ${zoneId}`);
      
      // CONFIGURAR DNS TIPO A
      console.log('🔧 [DNS] Configurando registro A...');
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
        {
          type: 'A',
          name: domain,
          content: config.HOSTING_SERVER_IP || '69.46.11.10',
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
      
      // CONFIGURAR DNS CNAME WWW
      console.log('🔧 [DNS] Configurando CNAME www...');
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
      
      // CONFIGURAR DNS CNAME REDTRACK
      console.log('🔧 [DNS] Configurando CNAME RedTrack...');
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
      console.log('🔒 [SSL] Configurando para Full...');
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
      
      // CRIAR REGRAS WAF
      console.log('🛡️ [WAF] Criando regras de firewall...');
      
      // Regra Sitemap
      await this.createWAFRule(zoneId, 
        '(http.request.uri.path contains "sitemap")', 
        'Block Sitemap Requests'
      );
      
      // Regra ?s=
      await this.createWAFRule(zoneId, 
        '(http.request.uri.query contains "?s=")', 
        'Block Search Queries'
      );
      
      console.log('✅ [CLOUDFLARE] Configuração completa!');
      
      return {
        zoneId,
        nameservers: ['ganz.ns.cloudflare.com', 'norah.ns.cloudflare.com']
      };
      
    } catch (error) {
      console.error('❌ [CLOUDFLARE] Erro:', error.message);
      
      if (error.response?.data?.errors?.[0]?.code === 1061) {
        console.log('ℹ️ Zona já existe');
        return { zoneId: null };
      }
      
      return { zoneId: null };
    }
  }

  /**
   * CRIAR REGRA WAF
   */
  async createWAFRule(zoneId, expression, description) {
    try {
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/firewall/rules`,
        {
          filter: { expression, description },
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
      console.log(`✅ WAF: ${description}`);
    } catch (error) {
      console.error(`⚠️ Erro WAF: ${description}`);
    }
  }

  /**
   * ADICIONAR DOMÍNIO AO CPANEL
   */
  async addDomainToCPanel(domain) {
    if (!config.CPANEL_URL || !config.CPANEL_USERNAME) {
      console.log('⚠️ cPanel não configurado');
      return false;
    }
    
    try {
      const cpanelUrl = `${config.CPANEL_URL}/json-api/cpanel`;
      
      const response = await axios.post(
        cpanelUrl,
        {
          cpanel_jsonapi_module: 'AddonDomain',
          cpanel_jsonapi_func: 'addaddondomain',
          cpanel_jsonapi_apiversion: '2',
          dir: `/home/${config.CPANEL_USERNAME}/public_html/${domain}`,
          newdomain: domain,
          subdomain: domain.replace(/\./g, '')
        },
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ [CPANEL] Domínio ${domain} adicionado`);
      return true;
      
    } catch (error) {
      console.error('❌ [CPANEL] Erro:', error.message);
      return false;
    }
  }

  /**
   * INSTALAR WORDPRESS VIA SOFTACULOUS
   */
  async installWordPressSoftaculous(domain) {
    if (!config.CPANEL_URL || !config.CPANEL_USERNAME) {
      console.log('⚠️ Softaculous não configurado');
      return false;
    }
    
    try {
      // Formatar nome do site (healthbodylife.online → Health Body Life)
      const siteName = domain
        .replace('.online', '')
        .split(/(?=[A-Z])/)
        .join(' ')
        .split('')
        .map((char, i) => i === 0 || domain[i-1] === ' ' ? char.toUpperCase() : char)
        .join('');
      
      const params = {
        softsubmit: '1',
        softdomain: domain,
        softdirectory: '', // Diretório raiz
        admin_username: config.WORDPRESS_DEFAULT_USER,
        admin_pass: config.WORDPRESS_DEFAULT_PASSWORD,
        admin_email: config.WORDPRESS_ADMIN_EMAIL,
        site_name: siteName,
        site_desc: siteName,
        dbprefix: 'wp_',
        language: 'pt_BR',
        wpsets: 'Plugins', // Pacote de plugins
        auto_upgrade: '1',
        auto_upgrade_plugins: '1',
        auto_upgrade_themes: '1'
      };
      
      const softaculousUrl = `${config.CPANEL_URL}:2087/frontend/x3/softaculous/index.live.php`;
      
      const response = await axios.post(
        softaculousUrl,
        new URLSearchParams(params).toString(),
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 60000
        }
      );
      
      console.log(`✅ [WORDPRESS] Instalado em ${domain}`);
      console.log(`   URL: https://${domain}`);
      console.log(`   Admin: https://${domain}/wp-admin`);
      console.log(`   Usuário: ${config.WORDPRESS_DEFAULT_USER}`);
      console.log(`   Nome do Site: ${siteName}`);
      
      return true;
      
    } catch (error) {
      console.error('❌ [WORDPRESS] Erro instalação:', error.message);
      return false;
    }
  }

  /**
   * SALVAR DOMÍNIO NO SUPABASE
   */
  async saveDomainToSupabase(domain, userId, cloudflareSetup) {
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
        p_integration_source: 'ai_purchase',
        p_last_stats_update: currentDate,
        p_nameservers: cloudflareSetup?.nameservers || ['ganz.ns.cloudflare.com', 'norah.ns.cloudflare.com'],
        p_dns_configured: true,
        p_auto_renew: false
      };
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE] Erro:', error);
        return null;
      }
      
      console.log('✅ [SUPABASE] Domínio salvo');
      
      // Buscar o domain_id para o log
      const { data: domainData } = await supabase
        .from('domains')
        .select('domain_id')
        .eq('domain_name', domain)
        .eq('user_id', userId || config.SUPABASE_USER_ID)
        .single();
      
      return domainData;
      
    } catch (error) {
      console.error('❌ [SUPABASE] Erro:', error.message);
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
          new_value: 'Domínio comprado com IA - WordPress'
        });
      
      if (error) {
        console.error('❌ [LOG] Erro:', error);
      } else {
        console.log('✅ [LOG] Atividade registrada');
      }
      
    } catch (error) {
      console.error('❌ [LOG] Erro:', error.message);
    }
  }

  /**
   * ENVIAR NOTIFICAÇÃO WHATSAPP
   */
  async sendWhatsAppNotification(domain, status, errorMsg = '') {
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
        message = `🎉 *NOVO DOMÍNIO WORDPRESS COMPRADO!*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `🌐 *URL:* https://${domain}\n` +
          `👤 *Admin:* https://${domain}/wp-admin\n` +
          `🔑 *Usuário:* ${config.WORDPRESS_DEFAULT_USER}\n` +
          `📅 *Data:* ${dataFormatada}\n` +
          `✅ *Status:* Compra e configuração completas\n\n` +
          `☁️ Cloudflare configurado\n` +
          `🌐 WordPress instalado\n` +
          `📦 Plugins padrão instalados\n\n` +
          `_Sistema DomainHub_`;
      } else {
        message = `❌ *ERRO NA COMPRA DE DOMÍNIO*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `⚠️ *Erro:* ${errorMsg}\n` +
          `📅 *Data:* ${dataFormatada}\n\n` +
          `_Sistema DomainHub_`;
      }
      
      await axios.post(
        `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}/send-text`,
        {
          phone: phoneNumber.replace(/\D/g, ''),
          message: message
        }
      );
      
      console.log('✅ [WHATSAPP] Notificação enviada');
      
    } catch (error) {
      console.error('❌ [WHATSAPP] Erro:', error.message);
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
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id' });
      
      if (error) console.error('❌ [CALLBACK] Erro:', error);
      
    } catch (error) {
      console.error('❌ [CALLBACK] Erro:', error.message);
    }
  }

  /**
   * HELPERS
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
      prompt += '\n\nSeja MUITO criativo e use combinações incomuns.';
    }
    
    return prompt;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WordPressDomainPurchase;