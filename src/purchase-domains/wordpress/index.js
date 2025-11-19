/**
 * COMPRA DE DOMÍNIOS WORDPRESS - VERSÃO FINAL CORRIGIDA
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
   * FUNÇÃO PRINCIPAL
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId } = params;
    
    console.log(`🚀 [WORDPRESS] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Compra manual
    if (domainManual) {
      console.log(`🔍 [MANUAL] Processando: ${domainManual}`);
      
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
        await this.processPostPurchase(domainManual, userId, sessionId);
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
            console.log(`🤖 [AI] Gerando domínio ${i + 1}/${quantidade} (tentativa ${retries + 1})`);
            await this.updateProgress(sessionId, 'generating', 'in_progress', 
              `Gerando domínio ${i + 1}/${quantidade}`);
            
            const generatedDomain = await this.generateDomainWithAI(nicho, idioma, retries > 0);
            
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
            
            console.log(`💳 Tentando comprar: ${generatedDomain} por $${availabilityCheck.price}`);
            await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
              `Comprando ${generatedDomain}...`);
            
            const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain);
            
            if (purchaseResult.success) {
              domain = generatedDomain;
              domainsToRegister.push(domain);
              successCount++;
              
              console.log(`✅ [WORDPRESS] Domínio comprado: ${domain}`);
              await this.processPostPurchase(domain, userId, sessionId);
              
            } else {
              console.error(`❌ Erro na compra: ${purchaseResult.error}`);
              
              // Se erro contém "Invalid", tentar outro domínio
              if (purchaseResult.error.includes('Invalid') || purchaseResult.error.includes('invalid')) {
                console.log(`⚠️ Domínio inválido segundo Namecheap, tentando outro...`);
                retries++;
                await this.delay(3000);
                continue;
              }
              
              // Se saldo insuficiente, parar
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
    
    // Callback final - SÓ SE REALMENTE COMPROU
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) comprado(s) com sucesso!`, domainsToRegister[0]);
      
      return {
        success: true,
        domainsRegistered: domainsToRegister,
        totalRequested: quantidade,
        totalRegistered: successCount
      };
    } else {
      await this.updateProgress(sessionId, 'error', 'error', 
        'Nenhum domínio foi comprado');
      
      return {
        success: false,
        error: 'Nenhum domínio foi comprado',
        totalRequested: quantidade,
        totalRegistered: 0
      };
    }
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

      console.log(`📊 [GODADDY] ${domain}`);
      console.log(`   Disponível: ${isAvailable ? '✅ SIM' : '❌ NÃO'}`);
      console.log(`   Preço: $${price.toFixed(2)}`);
      
      return {
        available: isAvailable,
        price: price,
        definitive: data.definitive || false
      };

    } catch (error) {
      console.error('❌ [GODADDY] Erro:', error.message);
      return { available: false, error: error.message };
    }
  }

  /**
   * GERAR DOMÍNIO COM IA
   */
  async generateDomainWithAI(nicho, idioma, isRetry) {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OpenAI API Key não configurada');
    }

    try {
      const prompt = this.buildPrompt(nicho, idioma, isRetry);
      
      const response = await axios.post(
        this.openaiAPI,
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Você é um especialista em criar nomes de domínios criativos e memoráveis.' },
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
      
      console.log(`✅ [AI] Domínio gerado: ${domain}`);
      return domain;
      
    } catch (error) {
      console.error('❌ [AI] Erro:', error.message);
      throw error;
    }
  }

  /**
   * COMPRAR DOMÍNIO NA NAMECHEAP - CORREÇÃO CRÍTICA
   * Enviar domínio COMPLETO como no N8N (não separar em nome + TLD)
   */
  async purchaseDomainNamecheap(domain) {
    try {
      console.log(`💳 [NAMECHEAP] Comprando: ${domain}`);
      
      // Validar formato
      if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
        console.error(`❌ [NAMECHEAP] Formato inválido: ${domain}`);
        return { success: false, error: 'Formato de domínio inválido' };
      }
      
      // Validar que termina com .online
      if (!domain.endsWith('.online')) {
        console.error(`❌ [NAMECHEAP] Domínio sem .online: ${domain}`);
        return { success: false, error: 'Domínio deve terminar com .online' };
      }
      
      // Validar caracteres
      const domainName = domain.replace('.online', '');
      if (!/^[a-z0-9]+$/i.test(domainName)) {
        console.error(`❌ [NAMECHEAP] Caracteres inválidos: ${domainName}`);
        return { success: false, error: 'Domínio com caracteres inválidos' };
      }
      
      console.log(`📝 [NAMECHEAP] Validação:`);
      console.log(`   Domínio completo: ${domain}`);
      console.log(`   Nome sem extensão: ${domainName}`);
      console.log(`   ✅ Válido para compra`);
      
      // CORREÇÃO CRÍTICA: Enviar domínio COMPLETO como no N8N
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        DomainName: domain,  // ← DOMÍNIO COMPLETO (como no N8N)
        Years: '1',
        
        // AuxBilling Contact
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
      
      console.log(`📤 [NAMECHEAP] Enviando requisição...`);
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      const xmlData = response.data;
      
      // VERIFICAR ERROS NO XML (como no N8N)
      const hasError = xmlData.includes('ERROR') || xmlData.includes('Status="ERROR"');
      
      if (hasError) {
        console.error(`❌ [NAMECHEAP] Status ERROR detectado`);
        
        // Extrair mensagem de erro
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        if (errorMatch) {
          const errorMessage = errorMatch[1];
          console.error(`❌ [NAMECHEAP] Erro: ${errorMessage}`);
          return { success: false, error: errorMessage };
        }
        
        // Se não encontrou padrão específico, mostrar XML
        console.error(`📄 [NAMECHEAP] XML com erro (primeiros 1000 chars):`);
        console.error(xmlData.substring(0, 1000));
        return { success: false, error: 'Erro na compra - verifique logs' };
      }
      
      // VERIFICAR SUCESSO
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        // Extrair nome do domínio comprado do XML
        const domainMatch = xmlData.match(/Domain="([^"]+)"/);
        const purchasedDomain = domainMatch ? domainMatch[1] : domain;
        
        console.log(`✅ [NAMECHEAP] Domínio ${purchasedDomain} comprado com sucesso!`);
        return { success: true, domain: purchasedDomain };
      }
      
      // Resposta inesperada
      console.error(`❌ [NAMECHEAP] Resposta inesperada`);
      console.error(`📄 [NAMECHEAP] XML (primeiros 1000 chars):`);
      console.error(xmlData.substring(0, 1000));
      return { success: false, error: 'Resposta inesperada' };
      
    } catch (error) {
      console.error(`❌ [NAMECHEAP] Erro:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * PROCESSAR PÓS-COMPRA
   */
  async processPostPurchase(domain, userId, sessionId) {
    try {
      console.log(`🔧 [POST-PURCHASE] Iniciando para ${domain}`);
      
      let cloudflareSetup = null;
      
      // Cloudflare
      await this.updateProgress(sessionId, 'cloudflare', 'in_progress', 
        `Configurando Cloudflare para ${domain}...`);
      cloudflareSetup = await this.setupCloudflare(domain);
      
      if (cloudflareSetup) {
        await this.updateProgress(sessionId, 'nameservers', 'in_progress', 
          `Alterando nameservers de ${domain}...`);
        await this.setNameservers(domain, cloudflareSetup.nameservers);
      }
      
      // cPanel
      await this.addDomainToCPanel(domain);
      
      // WordPress
      await this.installWordPress(domain);
      
      // Supabase
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup);
      
      // Log
      if (savedDomain?.domain_id) {
        await this.saveActivityLog(savedDomain.domain_id, userId);
      }
      
      // WhatsApp
      await this.sendWhatsAppNotification(domain, 'success');
      
      console.log(`✅ [POST-PURCHASE] Concluído para ${domain}`);
      
    } catch (error) {
      console.error(`❌ [POST-PURCHASE] Erro:`, error.message);
      await this.sendWhatsAppNotification(domain, 'error', error.message);
    }
  }

  /**
   * CONFIGURAR CLOUDFLARE
   */
  async setupCloudflare(domain) {
    if (!config.CLOUDFLARE_EMAIL || !config.CLOUDFLARE_API_KEY) {
      console.log('⚠️ Cloudflare não configurado');
      return null;
    }

    try {
      const response = await axios.post(
        `${this.cloudflareAPI}/zones`,
        {
          name: domain,
          account: { id: config.CLOUDFLARE_ACCOUNT_ID },
          jump_start: true,
          type: 'full'
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const zone = response.data.result;
      const nameservers = zone.name_servers || ['ganz.ns.cloudflare.com', 'norah.ns.cloudflare.com'];
      
      console.log(`✅ [CLOUDFLARE] Zona criada`);
      
      await this.delay(5000);
      
      if (config.HOSTING_SERVER_IP) {
        try {
          await axios.post(
            `${this.cloudflareAPI}/zones/${zone.id}/dns_records`,
            {
              type: 'A',
              name: domain,
              content: config.HOSTING_SERVER_IP,
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
          console.log(`✅ [CLOUDFLARE] Registro A criado`);
        } catch (dnsError) {
          console.error('⚠️ [CLOUDFLARE] Erro registro A:', dnsError.message);
        }
      }
      
      return { zoneId: zone.id, nameservers: nameservers };
      
    } catch (error) {
      console.error('❌ [CLOUDFLARE] Erro:', error.message);
      return null;
    }
  }

  /**
   * ALTERAR NAMESERVERS
   */
  async setNameservers(domain, nameservers) {
    try {
      const domainParts = domain.split('.');
      const tld = domainParts.pop();
      const sld = domainParts.join('.');
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.dns.setCustom',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        SLD: sld,
        TLD: tld,
        Nameservers: nameservers.join(',')
      };
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      
      if (response.data.includes('Status="OK"')) {
        console.log(`✅ [NAMESERVERS] Alterados`);
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.error('❌ [NAMESERVERS] Erro:', error.message);
      return false;
    }
  }

  /**
   * ADICIONAR AO CPANEL
   */
  async addDomainToCPanel(domain) {
    if (!config.CPANEL_API_TOKEN) {
      console.log('⚠️ cPanel não configurado');
      return false;
    }

    try {
      const response = await axios.get(
        `${config.CPANEL_URL}:2083/execute/DomainInfo/domains_data`,
        {
          params: { domain: domain, format: 'json' },
          headers: { 'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}` },
          timeout: 30000
        }
      );
      
      const existingDomains = response.data.data || [];
      if (existingDomains.some(d => d.domain === domain)) {
        console.log(`✅ [CPANEL] Domínio já existe`);
        return true;
      }
      
      const addResponse = await axios.post(
        `${config.CPANEL_URL}:2083/execute/AddonDomain/addaddondomain`,
        {
          newdomain: domain,
          subdomain: domain.split('.')[0],
          dir: `/public_html/${domain}`
        },
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 30000
        }
      );
      
      if (addResponse.data.status === 1) {
        console.log(`✅ [CPANEL] Domínio adicionado`);
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.error('❌ [CPANEL] Erro:', error.message);
      return false;
    }
  }

  /**
   * INSTALAR WORDPRESS
   */
  async installWordPress(domain) {
    if (!config.CPANEL_API_TOKEN || !config.WORDPRESS_DEFAULT_USER) {
      console.log('⚠️ WordPress não configurado');
      return false;
    }

    try {
      const siteName = domain.split('.')[0]
        .split('')
        .map((char, i) => i === 0 ? char.toUpperCase() : char)
        .join('');
      
      const params = {
        softsubmit: '1',
        softdomain: domain,
        softdirectory: '',
        admin_username: config.WORDPRESS_DEFAULT_USER,
        admin_pass: config.WORDPRESS_DEFAULT_PASSWORD,
        admin_email: config.WORDPRESS_ADMIN_EMAIL,
        site_name: siteName,
        site_desc: siteName,
        dbprefix: 'wp_',
        language: 'pt_BR',
        wpsets: 'Plugins',
        auto_upgrade: '1',
        auto_upgrade_plugins: '1',
        auto_upgrade_themes: '1'
      };
      
      await axios.post(
        `${config.CPANEL_URL}:2087/frontend/x3/softaculous/index.live.php`,
        new URLSearchParams(params).toString(),
        {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 60000
        }
      );
      
      console.log(`✅ [WORDPRESS] Instalado`);
      return true;
      
    } catch (error) {
      console.error('❌ [WORDPRESS] Erro:', error.message);
      return false;
    }
  }

  /**
   * SALVAR NO SUPABASE
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
        p_nameservers: cloudflareSetup?.nameservers || null,
        p_dns_configured: !!cloudflareSetup,
        p_auto_renew: false
      };
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE] Erro:', error);
        return null;
      }
      
      console.log('✅ [SUPABASE] Domínio salvo');
      
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
          new_value: 'Domínio comprado com IA - WordPress'
        });
      
      console.log('✅ [LOG] Registrado');
      
    } catch (error) {
      console.error('❌ [LOG] Erro:', error.message);
    }
  }

  /**
   * NOTIFICAR WHATSAPP
   */
  async sendWhatsAppNotification(domain, status, errorMsg = '') {
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
        message = `🎉 *NOVO DOMÍNIO WORDPRESS!*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `🌐 *URL:* https://${domain}\n` +
          `👤 *Admin:* https://${domain}/wp-admin\n` +
          `🔑 *Usuário:* ${config.WORDPRESS_DEFAULT_USER}\n` +
          `📅 *Data:* ${dataFormatada}\n` +
          `✅ *Status:* Completo\n\n` +
          `_Sistema DomainHub_`;
      } else {
        message = `❌ *ERRO NA COMPRA*\n\n` +
          `📌 *Domínio:* ${domain}\n` +
          `⚠️ *Erro:* ${errorMsg}\n` +
          `📅 *Data:* ${dataFormatada}\n\n` +
          `_Sistema DomainHub_`;
      }
      
      await axios.post(
        `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}/send-text`,
        { phone: phoneNumber.replace(/\D/g, ''), message: message },
        { timeout: 10000 }
      );
      
      console.log('✅ [WHATSAPP] Notificado');
      
    } catch (error) {
      console.error('❌ [WHATSAPP] Erro:', error.message);
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
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id' });
    } catch (error) {
      console.error('❌ [PROGRESS] Erro:', error.message);
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
    7. Faça uma verificação da disponibilidade do domínio
    8. Quero apenas domínios que ainda não foram criados
    
    Retorne APENAS um JSON no formato:
    {"domains": ["dominio.online"]}
    `;
    
    if (isRetry) {
      prompt += '\n\nIMPORTANTE: Seja MUITO criativo e use combinações diferentes das anteriores que falharam.';
    }
    
    return prompt;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WordPressDomainPurchase;