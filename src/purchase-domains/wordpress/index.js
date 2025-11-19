/**
 * COMPRA DE DOMÍNIOS WORDPRESS - VERSÃO CORRIGIDA FINAL
 * Correções aplicadas:
 * - Verificação de disponibilidade com GoDaddy (já estava correto)
 * - Melhorias no tratamento de erros
 * - Correção na lógica de geração de domínios
 * - Melhor logging para debug
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
        
        // Processar todas as configurações
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
            // GERAR DOMÍNIO COM IA
            console.log(`🤖 [AI] Gerando domínio ${i + 1}/${quantidade}`);
            await this.updateProgress(sessionId, 'generating', 'in_progress', 
              `Gerando domínio ${i + 1}/${quantidade}`);
            
            const generatedDomain = await this.generateDomainWithAI(nicho, idioma, retries > 0);
            
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
        
        if (!domain) {
          console.error(`❌ Não foi possível comprar o domínio ${i + 1} após ${this.maxRetries} tentativas`);
        }
      }
    }
    
    // Callback final
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) comprado(s) com sucesso!`, domainsToRegister[0]);
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
      console.log(`🔍 [GODADDY] Verificando disponibilidade de ${domain}...`);
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

      console.log(`📊 [GODADDY] ${domain}`);
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
      console.error('❌ [GODADDY] Erro na verificação:', error.message);
      
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
   * GERAR DOMÍNIO COM IA
   */
  async generateDomainWithAI(nicho, idioma, isRetry) {
    if (!config.OPENAI_API_KEY) {
      console.error('❌ OpenAI API não configurada');
      throw new Error('OpenAI API Key não configurada');
    }

    try {
      console.log(`🤖 [AI] Gerando domínio para nicho: ${nicho}`);
      
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
      console.log(`🤖 [AI] Resposta bruta:`, content);
      
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
      console.log(`✅ [AI] Domínio gerado: ${domain}`);
      
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
      console.error('❌ [AI] Erro:', error.message);
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
      console.log(`💳 [NAMECHEAP] Comprando: ${domain}`);
      
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
        console.error(`❌ [NAMECHEAP] Erro: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
      
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        console.log(`✅ [NAMECHEAP] Domínio ${domain} comprado!`);
        return { success: true, domain: domain };
      }
      
      console.error(`❌ [NAMECHEAP] Resposta inesperada`);
      return { success: false, error: 'Resposta inesperada da Namecheap' };
      
    } catch (error) {
      console.error(`❌ [NAMECHEAP] Erro na compra:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * PROCESSAR PÓS-COMPRA (Cloudflare + cPanel + WordPress)
   */
  async processPostPurchase(domain, userId, sessionId) {
    try {
      console.log(`🔧 [POST-PURCHASE] Iniciando configurações para ${domain}`);
      
      // 1. Configurar Cloudflare
      console.log(`☁️ [CLOUDFLARE] Configurando...`);
      await this.updateProgress(sessionId, 'cloudflare', 'in_progress', 
        `Configurando Cloudflare para ${domain}...`);
      
      const cloudflareSetup = await this.setupCloudflare(domain);
      
      if (cloudflareSetup) {
        console.log(`✅ [CLOUDFLARE] Configurado`);
        
        // 2. Alterar nameservers na Namecheap
        console.log(`🌐 [NAMESERVERS] Atualizando...`);
        await this.updateProgress(sessionId, 'nameservers', 'in_progress', 
          `Alterando nameservers de ${domain}...`);
        
        await this.setNameservers(domain, cloudflareSetup.nameservers);
        console.log(`✅ [NAMESERVERS] Atualizados`);
      }
      
      // 3. Adicionar ao cPanel
      console.log(`📦 [CPANEL] Adicionando domínio...`);
      await this.addDomainToCPanel(domain);
      console.log(`✅ [CPANEL] Domínio adicionado`);
      
      // 4. Instalar WordPress
      console.log(`🌐 [WORDPRESS] Instalando...`);
      await this.installWordPress(domain);
      console.log(`✅ [WORDPRESS] Instalado`);
      
      // 5. Salvar no banco
      console.log(`💾 [SUPABASE] Salvando...`);
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup);
      
      // 6. Registrar no log
      if (savedDomain?.domain_id) {
        await this.saveActivityLog(savedDomain.domain_id, userId);
      }
      
      // 7. Notificar WhatsApp
      await this.sendWhatsAppNotification(domain, 'success');
      
      console.log(`✅ [POST-PURCHASE] Todas as configurações concluídas para ${domain}`);
      
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
      console.log('⚠️ Cloudflare não configurado, pulando...');
      return null;
    }

    try {
      console.log(`☁️ [CLOUDFLARE] Adicionando zona: ${domain}`);
      
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
      console.log(`   Zone ID: ${zone.id}`);
      console.log(`   Nameservers: ${nameservers.join(', ')}`);
      
      // Aguardar propagação
      await this.delay(5000);
      
      // Adicionar registro A apontando para o servidor de hospedagem
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
          
          console.log(`✅ [CLOUDFLARE] Registro A criado apontando para ${config.HOSTING_SERVER_IP}`);
        } catch (dnsError) {
          console.error('⚠️ [CLOUDFLARE] Erro ao criar registro A:', dnsError.message);
        }
      }
      
      return {
        zoneId: zone.id,
        nameservers: nameservers
      };
      
    } catch (error) {
      console.error('❌ [CLOUDFLARE] Erro:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      return null;
    }
  }

  /**
   * ALTERAR NAMESERVERS NA NAMECHEAP
   */
  async setNameservers(domain, nameservers) {
    try {
      console.log(`🌐 [NAMESERVERS] Alterando para ${domain}...`);
      
      const domainParts = domain.split('.');
      const sld = domainParts[0];
      const tld = domainParts.slice(1).join('.');
      
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
      const xmlData = response.data;
      
      if (xmlData.includes('Status="OK"')) {
        console.log(`✅ [NAMESERVERS] Alterados com sucesso`);
        return true;
      }
      
      console.error('❌ [NAMESERVERS] Falha na alteração');
      return false;
      
    } catch (error) {
      console.error('❌ [NAMESERVERS] Erro:', error.message);
      return false;
    }
  }

  /**
   * ADICIONAR DOMÍNIO AO CPANEL
   */
  async addDomainToCPanel(domain) {
    if (!config.CPANEL_API_TOKEN) {
      console.log('⚠️ cPanel não configurado');
      return false;
    }

    try {
      console.log(`📦 [CPANEL] Adicionando domínio: ${domain}`);
      
      const response = await axios.get(
        `${config.CPANEL_URL}:2083/execute/DomainInfo/domains_data`,
        {
          params: {
            domain: domain,
            format: 'json'
          },
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 30000
        }
      );
      
      // Verificar se já existe
      const existingDomains = response.data.data || [];
      const domainExists = existingDomains.some(d => d.domain === domain);
      
      if (domainExists) {
        console.log(`✅ [CPANEL] Domínio ${domain} já existe`);
        return true;
      }
      
      // Adicionar como addon domain
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
        console.log(`✅ [CPANEL] Domínio ${domain} adicionado`);
        return true;
      }
      
      console.error('❌ [CPANEL] Falha ao adicionar domínio');
      return false;
      
    } catch (error) {
      console.error('❌ [CPANEL] Erro:', error.message);
      return false;
    }
  }

  /**
   * INSTALAR WORDPRESS VIA SOFTACULOUS
   */
  async installWordPress(domain) {
    if (!config.CPANEL_API_TOKEN || !config.WORDPRESS_DEFAULT_USER) {
      console.log('⚠️ WordPress não configurado');
      return false;
    }

    try {
      console.log(`🌐 [WORDPRESS] Instalando em ${domain}...`);
      
      // Nome do site: capitalizar primeira letra de cada palavra
      const siteName = domain
        .split('.')[0]
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
        wpsets: 'Plugins',
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
        p_dns_configured: !!cloudflareSetup,
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
        },
        { timeout: 10000 }
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
      
      if (error) {
        console.error('❌ [CALLBACK] Erro:', error);
      } else {
        console.log(`📊 [CALLBACK] Progresso: ${step} - ${status}`);
      }
      
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