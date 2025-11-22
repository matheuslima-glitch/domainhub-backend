/**
 * COMPRA DE DOMÍNIOS WORDPRESS - MODULO PRINCIPAL
 * VERSÃO CORRIGIDA COM VARIÁVEIS DE AMBIENTE CORRETAS
 */

const axios = require('axios');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

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
    
    // Site modelo para copiar plugins
    this.modelSitePath = `/home/${config.CPANEL_USERNAME}/mynervify.com`;
    
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
    const { quantidade, idioma, nicho, sessionId, domainManual, userId, trafficSource } = params;
    
    console.log(`🚀 [WORDPRESS] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    if (trafficSource) {
      console.log(`   Fonte de Tráfego: ${trafficSource}`);
    }
    
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
      
      // Verificar preço
      if (availabilityCheck.price > this.priceLimit) {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Domínio ${domainManual} muito caro: $${availabilityCheck.price}`);
        return { success: false, error: 'Domínio muito caro' };
      }
      
      // Comprar domínio
      const purchaseResult = await this.purchaseDomainNamecheap(domainManual);
      
      if (purchaseResult.success) {
        domainsToRegister.push(domainManual);
        successCount = 1;
        
        await this.updateProgress(sessionId, 'purchasing', 'completed', 
          `Domínio ${domainManual} comprado com sucesso!`, domainManual);
        
        // Processar todas as configurações
        await this.processPostPurchase(domainManual, userId, sessionId, trafficSource);
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
            
            console.log(`💳 Comprando: ${generatedDomain}`);
            await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
              `Comprando ${generatedDomain}...`);
            
            const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain);
            
            if (purchaseResult.success) {
              domain = generatedDomain;
              domainsToRegister.push(domain);
              successCount++;
              
              await this.updateProgress(sessionId, 'purchasing', 'completed', 
                `Domínio ${generatedDomain} comprado com sucesso!`, generatedDomain);
              
              await this.processPostPurchase(domain, userId, sessionId, trafficSource);
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
          console.error(`❌ Não foi possível comprar o domínio ${i + 1}`);
        }
      }
    }
    
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
   */
  async checkDomainAvailability(domain) {
    if (!config.GODADDY_API_KEY || !config.GODADDY_API_SECRET) {
      console.error('❌ [GODADDY] API não configurada!');
      return { available: false, error: 'GoDaddy API não configurada' };
    }

    try {
      console.log(`🔍 [GODADDY] Verificando disponibilidade de ${domain}...`);
      
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
      console.error('❌ [GODADDY] Erro na verificação:', error.message);
      
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        
        if (error.response.status === 401) {
          return { available: false, error: 'Autenticação GoDaddy falhou' };
        }
        if (error.response.status === 403) {
          return { available: false, error: 'Acesso GoDaddy negado' };
        }
        if (error.response.status === 422) {
          console.error('❌ [GODADDY] Domínio não é válido ou não pode ser registrado');
          return { available: false, error: 'Domínio inválido' };
        }
      }
      
      return { available: false, error: error.message };
    }
  }

  /**
   * GERAR DOMÍNIO COM OPENAI
   */
  async generateDomainWithAI(nicho, idioma, isRetry = false) {
    if (!config.OPENAI_API_KEY) {
      console.error('❌ [OPENAI] API não configurada!');
      return null;
    }

    try {
      console.log(`🤖 [OPENAI] Gerando domínio...`);
      console.log(`   Nicho: ${nicho}`);
      console.log(`   Idioma: ${idioma}`);
      console.log(`   Retry: ${isRetry ? 'SIM' : 'NÃO'}`);
      
      const prompt = this.buildPrompt(nicho, idioma, isRetry);
      
      const response = await axios.post(
        this.openaiAPI,
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Você é um especialista em marketing digital e criação de nomes de domínios.' },
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

      const content = response.data.choices[0].message.content;
      console.log(`📝 [OPENAI] Resposta bruta:`, content);
      
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const domain = parsed.domains?.[0] || parsed.domain;
        
        if (domain) {
          console.log(`✅ [OPENAI] Domínio gerado: ${domain}`);
          return domain.toLowerCase().trim();
        }
      }
      
      console.error('❌ [OPENAI] Não conseguiu extrair domínio da resposta');
      return null;

    } catch (error) {
      console.error('❌ [OPENAI] Erro:', error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
      }
      return null;
    }
  }

  /**
   * COMPRAR DOMÍNIO - NAMECHEAP
   */
  async purchaseDomainNamecheap(domain) {
    if (!config.NAMECHEAP_API_KEY || !config.NAMECHEAP_API_USER) {
      console.error('❌ [NAMECHEAP] API não configurada!');
      return { success: false, error: 'Namecheap API não configurada' };
    }

    try {
      console.log(`💳 [NAMECHEAP] Iniciando compra de ${domain}...`);
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        DomainName: domain,
        Years: '1',
        
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
        
        AddFreeWhoisguard: 'no',
        WGEnabled: 'no',
        GenerateAdminOrderRefId: 'False',
        IsPremiumDomain: 'False'
      };
      
      console.log(`📤 [NAMECHEAP] Enviando requisição...`);
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      const xmlData = response.data;
      
      console.log(`📥 [NAMECHEAP] Resposta XML recebida (primeiros 500 chars):`);
      console.log(xmlData.substring(0, 500));
      
      if (xmlData.includes('Status="ERROR"')) {
        console.error(`❌ [NAMECHEAP] Status ERROR detectado`);
        
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        if (errorMatch) {
          const errorMessage = errorMatch[1];
          console.error(`❌ [NAMECHEAP] Mensagem de erro: ${errorMessage}`);
          return { success: false, error: errorMessage };
        }
        
        console.error(`❌ [NAMECHEAP] XML completo da resposta de erro:`);
        console.error(xmlData);
        return { success: false, error: 'Erro na compra - verifique logs' };
      }
      
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        console.log(`✅ [NAMECHEAP] Domínio ${domain} comprado com sucesso!`);
        return { success: true, domain: domain };
      }
      
      console.error(`❌ [NAMECHEAP] Resposta inesperada (não é ERROR nem OK com DomainCreate)`);
      console.error(`📄 [NAMECHEAP] XML completo:`);
      console.error(xmlData);
      return { success: false, error: 'Resposta inesperada da Namecheap' };
      
    } catch (error) {
      console.error(`❌ [NAMECHEAP] Erro na compra:`, error.message);
      if (error.response) {
        console.error(`   Status HTTP: ${error.response.status}`);
        console.error(`   Data:`, error.response.data);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * PROCESSAR PÓS-COMPRA
   * ⚠️ ORDEM IMPORTANTE: Cloudflare → cPanel → WordPress → Plugins
   */
  async processPostPurchase(domain, userId, sessionId, trafficSource = null) {
    try {
      console.log(`🔧 [POST-PURCHASE] Iniciando configurações para ${domain}`);
      if (trafficSource) {
        console.log(`   Fonte de Tráfego: ${trafficSource}`);
      }
      
      let cloudflareSetup = null;
      
      // ========================
      // ETAPA 1: CLOUDFLARE
      // ========================
      await this.updateProgress(sessionId, 'cloudflare', 'in_progress', 
        `Configurando Cloudflare para ${domain}...`, domain);
      cloudflareSetup = await this.setupCloudflare(domain);
      
      if (cloudflareSetup) {
        // ETAPA 2: NAMESERVERS
        await this.updateProgress(sessionId, 'nameservers', 'in_progress', 
          `Alterando nameservers de ${domain}...`, domain);
        await this.setNameservers(domain, cloudflareSetup.nameservers);
      }
      
      console.log(`✅ [CLOUDFLARE] Configuração concluída - prosseguindo para cPanel`);
      
      // ========================
      // ETAPA 3: CPANEL
      // ========================
      console.log(`🖥️ [CPANEL] Adicionando domínio ao cPanel...`);
      await this.updateProgress(sessionId, 'cpanel', 'in_progress', 
        `Adicionando ${domain} ao cPanel...`, domain);
      await this.addDomainToCPanel(domain);
      
      console.log(`✅ [CPANEL] Domínio adicionado - prosseguindo para WordPress`);
      
      // ========================
      // ETAPA 4: WORDPRESS (APÓS CLOUDFLARE)
      // ========================
      console.log(`🌐 [WORDPRESS] Instalando WordPress...`);
      await this.updateProgress(sessionId, 'wordpress', 'in_progress', 
        `Instalando WordPress em ${domain}...`, domain);
      const wpInstalled = await this.installWordPress(domain);
      
      if (!wpInstalled) {
        console.error(`❌ [WORDPRESS] Falha na instalação - abortando configuração de plugins`);
        await this.updateProgress(sessionId, 'wordpress', 'error', 
          `Erro ao instalar WordPress em ${domain}`, domain);
      } else {
        console.log(`✅ [WORDPRESS] Instalado - prosseguindo para plugins`);
        
        // ========================
        // ETAPA 5: PLUGINS (APÓS WORDPRESS)
        // ========================
        console.log(`🔌 [PLUGINS] Configurando plugins...`);
        await this.updateProgress(sessionId, 'plugins', 'in_progress', 
          `Instalando e ativando plugins em ${domain}...`, domain);
        await this.setupWordPressPlugins(domain, sessionId);
      }
      
      // ========================
      // ETAPA 6: SUPABASE
      // ========================
      console.log(`💾 [SUPABASE] Salvando domínio no banco de dados...`);
      await this.updateProgress(sessionId, 'supabase', 'in_progress', 
        `Salvando informações de ${domain}...`, domain);
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource);
      
      // ========================
      // ETAPA 7: LOG
      // ========================
      if (savedDomain?.id) {
        console.log(`📝 [LOG] Registrando atividade...`);
        await this.saveActivityLog(savedDomain.id, userId, trafficSource);
      }
      
      // ========================
      // ETAPA 8: WHATSAPP
      // ========================
      console.log(`📱 [WHATSAPP] Enviando notificação...`);
      await this.sendWhatsAppNotification(domain, 'success');
      
      console.log(`✅ [POST-PURCHASE] Configurações concluídas para ${domain}`);
      
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
      console.log('⚠️ [CLOUDFLARE] Não configurado - pulando');
      return null;
    }

    try {
      console.log(`🌐 [CLOUDFLARE] Iniciando configuração completa para ${domain}`);
      
      // ETAPA 1: Criar zona na Cloudflare
      console.log(`📝 [CLOUDFLARE] Criando zona...`);
      const zoneResponse = await axios.post(
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
      
      const zoneId = zoneResponse.data.result.id;
      const nameservers = zoneResponse.data.result.name_servers;
      
      console.log(`✅ [CLOUDFLARE] Zona criada - ID: ${zoneId}`);
      console.log(`   Nameservers: ${nameservers.join(', ')}`);
      
      await this.delay(3000);
      
      // ETAPA 2: Criar CNAME www
      console.log(`📝 [CLOUDFLARE] Criando CNAME www...`);
      try {
        await axios.post(
          `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
          {
            type: 'CNAME',
            name: 'www',
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
        console.log(`✅ [CLOUDFLARE] CNAME www criado`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro CNAME www:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 3: Criar CNAME track (Redtrack)
      console.log(`📝 [CLOUDFLARE] Criando CNAME track...`);
      try {
        await axios.post(
          `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
          {
            type: 'CNAME',
            name: 'track',
            content: 'track.redtrack.io',
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
        console.log(`✅ [CLOUDFLARE] CNAME track criado (Redtrack)`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro CNAME track:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 4: Criar registro A
      console.log(`📝 [CLOUDFLARE] Criando registro A...`);
      const serverIP = config.HOSTING_SERVER_IP || '69.46.11.10';
      try {
        await axios.post(
          `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
          {
            type: 'A',
            name: domain,
            content: serverIP,
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
        console.log(`✅ [CLOUDFLARE] Registro A criado (IP: ${serverIP})`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro registro A:`, error.message);
      }
      
      await this.delay(3000);
      
      // ETAPA 5: Buscar domínio específico (verificar se foi criado)
      console.log(`🔍 [CLOUDFLARE] Buscando domínio específico...`);
      try {
        const searchResponse = await axios.get(
          `${this.cloudflareAPI}/zones`,
          {
            params: { name: domain },
            headers: {
              'X-Auth-Email': config.CLOUDFLARE_EMAIL,
              'X-Auth-Key': config.CLOUDFLARE_API_KEY
            }
          }
        );
        console.log(`✅ [CLOUDFLARE] Domínio encontrado na busca`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro ao buscar:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 6: Buscar registros DNS (verificação)
      console.log(`🔍 [CLOUDFLARE] Buscando registros DNS...`);
      try {
        const dnsResponse = await axios.get(
          `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
          {
            headers: {
              'X-Auth-Email': config.CLOUDFLARE_EMAIL,
              'X-Auth-Key': config.CLOUDFLARE_API_KEY
            }
          }
        );
        const records = dnsResponse.data.result || [];
        console.log(`✅ [CLOUDFLARE] ${records.length} registros DNS encontrados`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro ao buscar DNS:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 7: Alterar SSL para "full"
      console.log(`🔒 [CLOUDFLARE] Alterando SSL para Full...`);
      try {
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
        console.log(`✅ [CLOUDFLARE] SSL alterado para Full`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro SSL:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 8: Criar Filtro WAF - Sitemap
      console.log(`🛡️ [CLOUDFLARE] Criando filtro WAF - Sitemap...`);
      let sitemapFilterId = null;
      try {
        const sitemapFilterResponse = await axios.post(
          `${this.cloudflareAPI}/zones/${zoneId}/filters`,
          [
            {
              expression: '(http.request.uri contains "sitemap" or http.request.full_uri contains "sitemap")',
              paused: false,
              description: 'Bloqueio (Sitemap)'
            }
          ],
          {
            headers: {
              'X-Auth-Email': config.CLOUDFLARE_EMAIL,
              'X-Auth-Key': config.CLOUDFLARE_API_KEY,
              'Content-Type': 'application/json'
            }
          }
        );
        sitemapFilterId = sitemapFilterResponse.data.result[0].id;
        console.log(`✅ [CLOUDFLARE] Filtro WAF Sitemap criado - ID: ${sitemapFilterId}`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro filtro Sitemap:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 9: Criar Regra de Bloqueio - Sitemap
      if (sitemapFilterId) {
        console.log(`🛡️ [CLOUDFLARE] Criando regra bloqueio - Sitemap...`);
        try {
          await axios.post(
            `${this.cloudflareAPI}/zones/${zoneId}/firewall/rules`,
            [
              {
                action: 'block',
                filter: { id: sitemapFilterId },
                description: 'Bloqueio-Sitemap'
              }
            ],
            {
              headers: {
                'X-Auth-Email': config.CLOUDFLARE_EMAIL,
                'X-Auth-Key': config.CLOUDFLARE_API_KEY,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`✅ [CLOUDFLARE] Regra bloqueio Sitemap criada`);
        } catch (error) {
          console.error(`⚠️ [CLOUDFLARE] Erro regra Sitemap:`, error.message);
        }
      }
      
      await this.delay(2000);
      
      // ETAPA 10: Criar Filtro WAF - ?s=
      console.log(`🛡️ [CLOUDFLARE] Criando filtro WAF - ?s=...`);
      let queryFilterId = null;
      try {
        const queryFilterResponse = await axios.post(
          `${this.cloudflareAPI}/zones/${zoneId}/filters`,
          [
            {
              expression: '(http.request.uri contains "?s=" or http.request.full_uri contains "?s=")',
              paused: false,
              description: 'Bloqueio (?s=)'
            }
          ],
          {
            headers: {
              'X-Auth-Email': config.CLOUDFLARE_EMAIL,
              'X-Auth-Key': config.CLOUDFLARE_API_KEY,
              'Content-Type': 'application/json'
            }
          }
        );
        queryFilterId = queryFilterResponse.data.result[0].id;
        console.log(`✅ [CLOUDFLARE] Filtro WAF ?s= criado - ID: ${queryFilterId}`);
      } catch (error) {
        console.error(`⚠️ [CLOUDFLARE] Erro filtro ?s=:`, error.message);
      }
      
      await this.delay(2000);
      
      // ETAPA 11: Criar Regra de Bloqueio - ?s=
      if (queryFilterId) {
        console.log(`🛡️ [CLOUDFLARE] Criando regra bloqueio - ?s=...`);
        try {
          await axios.post(
            `${this.cloudflareAPI}/zones/${zoneId}/firewall/rules`,
            [
              {
                action: 'block',
                filter: { id: queryFilterId },
                description: 'Bloqueio-?s='
              }
            ],
            {
              headers: {
                'X-Auth-Email': config.CLOUDFLARE_EMAIL,
                'X-Auth-Key': config.CLOUDFLARE_API_KEY,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`✅ [CLOUDFLARE] Regra bloqueio ?s= criada`);
        } catch (error) {
          console.error(`⚠️ [CLOUDFLARE] Erro regra ?s=:`, error.message);
        }
      }
      
      console.log(`🎉 [CLOUDFLARE] Configuração completa finalizada!`);
      console.log(`   Zone ID: ${zoneId}`);
      console.log(`   DNS: A, CNAME www, CNAME track`);
      console.log(`   SSL: Full`);
      console.log(`   WAF: 2 filtros + 2 regras de bloqueio`);
      
      return { zoneId: zoneId, nameservers: nameservers };
      
    } catch (error) {
      console.error('❌ [CLOUDFLARE] Erro geral:', error.message);
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
        console.log(`✅ [NAMESERVERS] Alterados com sucesso`);
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
      console.log('⚠️ [CPANEL] API não configurada - pulando');
      return false;
    }

    try {
      console.log(`🖥️ [CPANEL] Adicionando domínio: ${domain}`);
      
      // Verificar se o domínio já existe
      console.log(`🔍 [CPANEL] Verificando se domínio já existe...`);
      const response = await axios.get(
        `${config.CPANEL_URL}/execute/DomainInfo/domains_data`,
        {
          params: { domain: domain, format: 'json' },
          headers: { 
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}` 
          },
          timeout: 30000
        }
      );
      
      let existingDomains = response.data.data || [];
      if (!Array.isArray(existingDomains)) {
        console.log('⚠️ [CPANEL] Resposta não é array, convertendo...');
        existingDomains = [];
      }
      
      const domainExists = existingDomains.some(d => d.domain === domain);
      
      if (domainExists) {
        console.log(`✅ [CPANEL] Domínio ${domain} já existe`);
        return true;
      }
      
      // Adicionar domínio usando JSON API
      console.log(`📝 [CPANEL] Adicionando novo domínio...`);
      
      const addResponse = await axios.post(
        `${config.CPANEL_URL}/json-api/cpanel`,
        null,
        {
          params: {
            cpanel_jsonapi_module: 'AddonDomain',
            cpanel_jsonapi_func: 'addaddondomain',
            newdomain: domain,
            subdomain: domain.split('.')[0],
            dir: `/public_html/${domain}`,
            disallowdot: 1
          },
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 30000
        }
      );
      
      console.log(`📥 [CPANEL] Resposta:`, JSON.stringify(addResponse.data, null, 2));
      
      if (addResponse.data.cpanelresult?.data?.result === 1) {
        console.log(`✅ [CPANEL] Domínio ${domain} adicionado com sucesso`);
        return true;
      }
      
      if (addResponse.data.cpanelresult?.error) {
        console.error(`❌ [CPANEL] Erro:`, addResponse.data.cpanelresult.error);
        return false;
      }
      
      return false;
      
    } catch (error) {
      console.error('❌ [CPANEL] Erro:', error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
      }
      return false;
    }
  }

  /**
   * INSTALAR WORDPRESS VIA SOFTACULOUS
   * ⚠️ USA AS VARIÁVEIS DE AMBIENTE CORRETAS
   */
  async installWordPress(domain) {
    try {
      console.log(`🌐 [WORDPRESS] Instalando WordPress em ${domain}`);
      
      const siteName = domain.split('.')[0]
        .split('')
        .map((char, i) => i === 0 ? char.toUpperCase() : char)
        .join('');
      
      // Endpoint CORRETO da API Softaculous usando variáveis de ambiente
      const softaculousUrl = `${config.CPANEL_URL}/frontend/jupiter/softaculous/index.live.php`;
      
      const params = {
        api: 'json',
        act: 'software',
        soft: '26' // WordPress ID no Softaculous
      };
      
      const data = {
        softsubmit: '1',
        softdomain: domain,
        softdirectory: '',
        admin_username: config.WORDPRESS_DEFAULT_USER || 'love9365',
        admin_pass: config.WORDPRESS_DEFAULT_PASSWORD || 'DiyEMn^7q4az#<22',
        admin_email: config.WORDPRESS_ADMIN_EMAIL || 'domain@gexcorp.com.br',
        site_name: siteName,
        language: 'pt_BR'
      };
      
      console.log(`📤 [WORDPRESS] Enviando requisição para Softaculous...`);
      console.log(`   URL: ${softaculousUrl}`);
      console.log(`   Domínio: ${domain}`);
      console.log(`   User: ${config.CPANEL_USERNAME}`);
      
      const response = await axios.post(
        softaculousUrl,
        new URLSearchParams(data).toString(),
        {
          params: params,
          auth: {
            username: config.CPANEL_USERNAME,
            password: config.CPANEL_PASSWORD
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 120000
        }
      );
      
      console.log(`📥 [WORDPRESS] Resposta recebida`);
      
      // Verificar sucesso
      if (response.data && response.data.insid) {
        console.log(`✅ [WORDPRESS] Instalado com sucesso!`);
        console.log(`   Installation ID: ${response.data.insid}`);
        console.log(`   URL: https://${domain}`);
        console.log(`   Admin: https://${domain}/wp-admin`);
        return true;
      }
      
      console.error(`❌ [WORDPRESS] Instalação falhou`);
      console.error(`   Response:`, JSON.stringify(response.data, null, 2));
      return false;
      
    } catch (error) {
      console.error('❌ [WORDPRESS] Erro:', error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
      }
      return false;
    }
  }

  /**
   * CONFIGURAR PLUGINS DO WORDPRESS
   * ⚠️ USA AS VARIÁVEIS DE AMBIENTE CORRETAS
   */
  async setupWordPressPlugins(domain, sessionId) {
    try {
      const destinationPath = `/home/${config.CPANEL_USERNAME}/${domain}`;
      
      console.log(`🔌 [PLUGINS] Iniciando configuração de plugins para ${domain}`);
      console.log(`   Origem: ${this.modelSitePath}`);
      console.log(`   Destino: ${destinationPath}`);
      
      // ETAPA 1: Copiar plugins do site modelo
      console.log(`📋 [PLUGINS] Copiando plugins do site modelo...`);
      await this.updateProgress(sessionId, 'plugins', 'in_progress', 
        `Copiando plugins para ${domain}...`, domain);
      
      const copyCommand = `
        cp -r ${this.modelSitePath}/wp-content/plugins/* ${destinationPath}/wp-content/plugins/ && \
        chmod -R 755 ${destinationPath}/wp-content/plugins/ && \
        chown -R ${config.CPANEL_USERNAME}:${config.CPANEL_USERNAME} ${destinationPath}/wp-content/plugins/
      `;
      
      await execAsync(copyCommand);
      console.log(`✅ [PLUGINS] Plugins copiados com sucesso`);
      
      // Aguardar propagação dos arquivos
      await this.delay(3000);
      
      // ETAPA 2: Ativar todos os plugins via WP-CLI
      console.log(`🔌 [PLUGINS] Ativando plugins...`);
      await this.updateProgress(sessionId, 'plugins', 'in_progress', 
        `Ativando plugins em ${domain}...`, domain);
      
      const activateCommand = `
        cd ${destinationPath} && \
        wp plugin activate wordfence --allow-root && \
        wp plugin activate wordpress-seo --allow-root && \
        wp plugin activate litespeed-cache --allow-root && \
        wp plugin activate elementor --allow-root && \
        wp plugin activate elementor-pro --allow-root && \
        wp plugin activate elementor-automation --allow-root && \
        wp plugin activate insert-headers-and-footers --allow-root && \
        wp plugin activate google-site-kit --allow-root && \
        wp plugin activate rename-wp-admin-login --allow-root && \
        wp plugin activate duplicate-post --allow-root
      `;
      
      const { stdout: activateOutput } = await execAsync(activateCommand);
      console.log(`✅ [PLUGINS] Plugins ativados:`);
      console.log(activateOutput);
      
      // ETAPA 3: Habilitar auto-update para todos os plugins
      console.log(`🔄 [PLUGINS] Habilitando auto-update...`);
      await this.updateProgress(sessionId, 'plugins', 'in_progress', 
        `Configurando auto-update de plugins em ${domain}...`, domain);
      
      const autoUpdateCommand = `
        cd ${destinationPath} && \
        wp plugin auto-updates enable --all --allow-root
      `;
      
      await execAsync(autoUpdateCommand);
      console.log(`✅ [PLUGINS] Auto-update habilitado`);
      
      // ETAPA 4: Forçar atualização imediata de todos os plugins
      console.log(`⚡ [PLUGINS] Atualizando plugins para versão mais recente...`);
      await this.updateProgress(sessionId, 'plugins', 'in_progress', 
        `Atualizando plugins em ${domain}...`, domain);
      
      const updateCommand = `
        cd ${destinationPath} && \
        wp plugin update --all --allow-root
      `;
      
      const { stdout: updateOutput } = await execAsync(updateCommand);
      console.log(`✅ [PLUGINS] Plugins atualizados:`);
      console.log(updateOutput);
      
      // ETAPA 5: Verificar status final
      console.log(`🔍 [PLUGINS] Verificando status final...`);
      
      const listCommand = `
        cd ${destinationPath} && \
        wp plugin list --status=active --allow-root
      `;
      
      const { stdout: listOutput } = await execAsync(listCommand);
      console.log(`📋 [PLUGINS] Plugins ativos:`);
      console.log(listOutput);
      
      console.log(`🎉 [PLUGINS] Configuração completa de plugins finalizada!`);
      
      await this.updateProgress(sessionId, 'plugins', 'completed', 
        `Plugins instalados e configurados em ${domain}`, domain);
      
      return true;
      
    } catch (error) {
      console.error(`❌ [PLUGINS] Erro:`, error.message);
      if (error.stderr) {
        console.error(`   Stderr:`, error.stderr);
      }
      
      await this.updateProgress(sessionId, 'plugins', 'error', 
        `Erro ao configurar plugins: ${error.message}`, domain);
      
      return false;
    }
  }

  /**
   * BUSCAR INFORMAÇÕES DO DOMÍNIO NA NAMECHEAP
   */
  async getDomainInfoFromNamecheap(domain) {
    try {
      console.log(`🔍 [NAMECHEAP] Buscando informações de ${domain}...`);
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.getInfo',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        DomainName: domain
      };
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      const xmlData = response.data;
      
      if (!xmlData.includes('Status="OK"')) {
        console.error('⚠️ [NAMECHEAP] Erro ao buscar informações');
        return null;
      }
      
      const info = {
        domain_name: domain
      };
      
      const createdDateMatch = xmlData.match(/CreatedDate="([^"]+)"/);
      if (createdDateMatch) {
        info.created_date = createdDateMatch[1];
      }
      
      const expiresMatch = xmlData.match(/Expires="([^"]+)"/);
      if (expiresMatch) {
        info.expiration_date = expiresMatch[1];
      }
      
      const statusMatch = xmlData.match(/Status="([^"]+)"/);
      if (statusMatch) {
        info.status = statusMatch[1];
      }
      
      const whoisGuardMatch = xmlData.match(/WhoisGuard="([^"]+)"/);
      if (whoisGuardMatch) {
        info.whois_guard = whoisGuardMatch[1] === 'ENABLED';
      }
      
      const autoRenewMatch = xmlData.match(/AutoRenew="([^"]+)"/);
      if (autoRenewMatch) {
        info.auto_renew = autoRenewMatch[1] === 'true';
      }
      
      console.log(`✅ [NAMECHEAP] Informações obtidas:`);
      console.log(`   Criado: ${info.created_date || 'N/A'}`);
      console.log(`   Expira: ${info.expiration_date || 'N/A'}`);
      console.log(`   Status: ${info.status || 'N/A'}`);
      
      return info;
      
    } catch (error) {
      console.error(`⚠️ [NAMECHEAP] Erro ao buscar info:`, error.message);
      return null;
    }
  }

  /**
   * SALVAR NO SUPABASE
   */
  async saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource = null) {
    try {
      console.log(`💾 [SUPABASE] Buscando informações completas antes de salvar...`);
      
      const namecheapInfo = await this.getDomainInfoFromNamecheap(domain);
      
      const currentDate = new Date().toISOString();
      
      let expirationDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      if (namecheapInfo?.expiration_date) {
        expirationDate = new Date(namecheapInfo.expiration_date).toISOString();
      }
      
      const payload = {
        p_user_id: userId || config.SUPABASE_USER_ID,
        p_domain_name: domain,
        p_expiration_date: expirationDate,
        p_purchase_date: namecheapInfo?.created_date || currentDate,
        p_status: 'active',
        p_registrar: 'Namecheap',
        p_integration_source: 'namecheap',
        p_last_stats_update: currentDate,
        p_nameservers: cloudflareSetup?.nameservers || null,
        p_dns_configured: !!cloudflareSetup,
        p_auto_renew: namecheapInfo?.auto_renew || false
      };
      
      if (trafficSource) {
        payload.p_traffic_source = trafficSource;
        console.log(`   Fonte de Tráfego: ${trafficSource}`);
      }
      
      console.log(`💾 [SUPABASE] Salvando domínio...`);
      console.log(`   Payload:`, JSON.stringify(payload, null, 2));
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE] Erro:', error);
        console.error('   Code:', error.code);
        console.error('   Message:', error.message);
        console.error('   Details:', error.details);
        console.error('   Hint:', error.hint);
        return null;
      }
      
      console.log('✅ [SUPABASE] Domínio salvo com sucesso');
      
      const { data: domainData, error: fetchError } = await supabase
        .from('domains')
        .select('id')
        .eq('domain_name', domain)
        .eq('user_id', userId || config.SUPABASE_USER_ID)
        .single();
      
      if (fetchError) {
        console.error('⚠️ [SUPABASE] Erro ao buscar domain_id:', fetchError.message);
        return null;
      }
      
      console.log(`✅ [SUPABASE] Domain ID: ${domainData.id}`);
      
      return domainData;
      
    } catch (error) {
      console.error('❌ [SUPABASE] Erro:', error.message);
      if (error.stack) {
        console.error('   Stack:', error.stack);
      }
      return null;
    }
  }

  /**
   * REGISTRAR LOG
   */
  async saveActivityLog(domainId, userId, trafficSource = null) {
    try {
      console.log(`📝 [LOG] Registrando atividade para domínio ${domainId}...`);
      
      let newValue = 'Domínio comprado com IA - WordPress + Plugins';
      if (trafficSource) {
        newValue += ` | Fonte de Tráfego: ${trafficSource}`;
      }
      
      const { data, error } = await supabase
        .from('domain_activity_logs')
        .insert({
          domain_id: domainId,
          user_id: userId || config.SUPABASE_USER_ID,
          action_type: 'created',
          old_value: null,
          new_value: newValue,
          created_at: new Date().toISOString()
        });
      
      if (error) {
        console.error('❌ [LOG] Erro ao registrar:', error);
        console.error('   Message:', error.message);
        return;
      }
      
      console.log('✅ [LOG] Atividade registrada com sucesso');
      if (trafficSource) {
        console.log(`   Com fonte de tráfego: ${trafficSource}`);
      }
      
    } catch (error) {
      console.error('❌ [LOG] Erro:', error.message);
    }
  }

  /**
   * NOTIFICAR WHATSAPP
   */
  async sendWhatsAppNotification(domain, status, errorMsg = '') {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ [WHATSAPP] ZAPI não configurado - pulando');
      return;
    }
    
    try {
      const phoneNumber = config.WHATSAPP_PHONE_NUMBER;
      
      const agora = new Date();
      const dataFormatada = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }).format(agora);
      
      const horaFormatada = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(agora);
      
      let message;
      if (status === 'success') {
        message = `🤖 *Domain Hub*\n\n` +
          `Lerricke, um novo domínio foi criado ✅:\n\n` +
          `🌐Domínio: ${domain}\n` +
          `🛜 Plataforma: WordPress + Plugins\n` +
          `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;
      } else {
        message = `🤖 *Domain Hub*\n\n` +
          `Lerricke, houve um erro ao criar o domínio ❌:\n\n` +
          `🌐Domínio tentado: ${domain}\n` +
          `❌Erro: ${errorMsg}\n` +
          `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;
      }
      
      console.log(`📱 [WHATSAPP] Enviando para: ${phoneNumber}`);
      console.log(`   Mensagem: ${message.substring(0, 50)}...`);
      const zapiUrl = config.ZAPI_INSTANCE;
      
      console.log(`🌐 [WHATSAPP] URL: ${zapiUrl}`);
      
      const response = await axios.post(
        zapiUrl,
        { 
          phone: phoneNumber.replace(/\D/g, ''), 
          message: message 
        },
        { 
          timeout: 10000,
          headers: {
            'Client-Token': config.ZAPI_CLIENT_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('✅ [WHATSAPP] Notificação enviada com sucesso');
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));
      
    } catch (error) {
      console.error('❌ [WHATSAPP] Erro ao enviar:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
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