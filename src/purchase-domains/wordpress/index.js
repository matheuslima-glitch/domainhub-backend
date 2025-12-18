/**
 * COMPRA DE DOMÍNIOS WORDPRESS 
 * COM CALLBACKS COMPLETOS PARA FRONTEND
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

// Cache global de sessões canceladas (compartilhado entre instâncias)
const cancelledSessions = new Set();

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
    
    // 🔥 CAMINHO CORRETO - SEMPRE /home/USERNAME
    this.basePath = `/home/${config.CPANEL_USERNAME}`;
    
    // Site modelo para copiar plugins
    this.modelSitePath = `${this.basePath}/mynervify.com`;
    
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
   * VERIFICAR SE SESSÃO FOI CANCELADA
   * Verifica tanto no cache local quanto no Supabase
   */
  async isSessionCancelled(sessionId) {
    // Verificar cache local primeiro (mais rápido)
    if (cancelledSessions.has(sessionId)) {
      console.log(`🛑 [CANCEL] Sessão ${sessionId} encontrada no cache de cancelados`);
      return true;
    }
    
    // Verificar no Supabase
    try {
      const { data } = await supabase
        .from('domain_purchase_progress')
        .select('status')
        .eq('session_id', sessionId)
        .single();
      
      if (data?.status === 'canceled') {
        cancelledSessions.add(sessionId); // Adicionar ao cache
        console.log(`🛑 [CANCEL] Sessão ${sessionId} cancelada (Supabase)`);
        return true;
      }
    } catch (error) {
      // Ignorar erro de busca
    }
    
    return false;
  }

  /**
   * MARCAR SESSÃO COMO CANCELADA
   */
  static markAsCancelled(sessionId) {
    cancelledSessions.add(sessionId);
    console.log(`🛑 [CANCEL] Sessão ${sessionId} marcada como cancelada`);
  }

  /**
   * FUNÇÃO PRINCIPAL - ORQUESTRA TODO O PROCESSO
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId, trafficSource, plataforma, isManual } = params;
    
    console.log(`🚀 [WORDPRESS] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    console.log(`   Sem limite de preço: ${isManual ? 'SIM' : 'NÃO'}`);
    if (trafficSource) {
      console.log(`   Fonte de Tráfego: ${trafficSource}`);
    }
    if (plataforma) {
      console.log(`   Plataforma: ${plataforma}`);
    }
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Se for compra manual, processar diretamente
    if (domainManual) {
      console.log(`🔍 [MANUAL] Processando domínio manual: ${domainManual}`);
      
      // ⚠️ CHECKPOINT: Verificar cancelamento antes de verificar disponibilidade
      if (await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL] Processo cancelado antes da verificação de disponibilidade`);
        await this.updateProgress(sessionId, 'canceled', 'canceled', 'Compra cancelada pelo usuário');
        return { success: false, error: 'Compra cancelada pelo usuário', cancelled: true };
      }
      
      // Verificar disponibilidade com GoDaddy
      const availabilityCheck = await this.checkDomainAvailability(domainManual);
      
      if (!availabilityCheck.available) {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Domínio ${domainManual} não está disponível`);
        return { success: false, error: 'Domínio não disponível' };
      }
      
      // Verificar preço APENAS se NÃO for compra manual
      if (!isManual && availabilityCheck.price > this.priceLimit) {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Domínio ${domainManual} muito caro: $${availabilityCheck.price}`);
        return { success: false, error: 'Domínio muito caro' };
      }
      
      // Log do preço para compra manual
      if (isManual) {
        console.log(`💰 [MANUAL] Preço do domínio: $${availabilityCheck.price} (sem limite de preço)`);
      }
      
      // ⚠️ CHECKPOINT: Verificar cancelamento antes de comprar
      if (await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL] Processo cancelado antes da compra`);
        await this.updateProgress(sessionId, 'canceled', 'canceled', 'Compra cancelada pelo usuário');
        return { success: false, error: 'Compra cancelada pelo usuário', cancelled: true };
      }
      
      // Comprar domínio
      const purchaseResult = await this.purchaseDomainNamecheap(domainManual);
      
      if (purchaseResult.success) {
        domainsToRegister.push(domainManual);
        successCount = 1;
        
        await this.updateProgress(sessionId, 'purchasing', 'completed', 
          `Domínio ${domainManual} comprado com sucesso!`, domainManual);
        
        // ⚠️ CHECKPOINT: Verificar cancelamento antes do pós-compra
        if (await this.isSessionCancelled(sessionId)) {
          console.log(`🛑 [CANCEL] Processo cancelado após compra - domínio já foi comprado!`);
          await this.updateProgress(sessionId, 'canceled', 'canceled', 
            'Processo cancelado. ATENÇÃO: Domínio já foi comprado na Namecheap!');
          return { 
            success: true, 
            domainsRegistered: [domainManual],
            totalRequested: 1,
            totalRegistered: 1,
            cancelled: true,
            warning: 'Processo cancelado após compra - domínio registrado mas configuração interrompida'
          };
        }
        
        // Processar todas as configurações (incluindo plataforma)
        await this.processPostPurchase(domainManual, userId, sessionId, trafficSource, plataforma, true);
      } else {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Erro na compra: ${purchaseResult.error}`);
        return { success: false, error: purchaseResult.error };
      }
      
    } else {
      // Compra com IA
      for (let i = 0; i < quantidade; i++) {
        // ⚠️ CHECKPOINT: Verificar cancelamento no início de cada iteração
        if (await this.isSessionCancelled(sessionId)) {
          console.log(`🛑 [CANCEL] Processo cancelado no início da iteração ${i + 1}`);
          await this.updateProgress(sessionId, 'canceled', 'canceled', 
            `Compra cancelada. ${successCount} domínio(s) já comprado(s).`);
          return { 
            success: successCount > 0, 
            domainsRegistered: domainsToRegister,
            totalRequested: quantidade,
            totalRegistered: successCount,
            cancelled: true
          };
        }
        
        let domain = null;
        let retries = 0;
        
        while (!domain && retries < this.maxRetries) {
          try {
            // ⚠️ CHECKPOINT: Verificar cancelamento em cada retry
            if (await this.isSessionCancelled(sessionId)) {
              console.log(`🛑 [CANCEL] Processo cancelado durante retry ${retries}`);
              throw new Error('CANCELLED');
            }
            
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
            
            // ⚠️ CHECKPOINT: Verificar cancelamento antes de comprar
            if (await this.isSessionCancelled(sessionId)) {
              console.log(`🛑 [CANCEL] Processo cancelado antes de comprar ${generatedDomain}`);
              throw new Error('CANCELLED');
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
              
              // ⚠️ CHECKPOINT: Verificar cancelamento antes do pós-compra
              if (await this.isSessionCancelled(sessionId)) {
                console.log(`🛑 [CANCEL] Processo cancelado após comprar ${generatedDomain} - configuração interrompida`);
                // Não interrompe aqui, deixa salvar no Supabase pelo menos
              }
              
              await this.processPostPurchase(domain, userId, sessionId, trafficSource, plataforma, false);
            } else {
              console.error(`❌ Erro na compra: ${purchaseResult.error}`);
              retries++;
              await this.delay(3000);
            }
            
          } catch (error) {
            // Se foi cancelado, sair do loop
            if (error.message === 'CANCELLED') {
              console.log(`🛑 [CANCEL] Loop interrompido por cancelamento`);
              await this.updateProgress(sessionId, 'canceled', 'canceled', 
                `Compra cancelada. ${successCount} domínio(s) já comprado(s).`);
              return { 
                success: successCount > 0, 
                domainsRegistered: domainsToRegister,
                totalRequested: quantidade,
                totalRegistered: successCount,
                cancelled: true
              };
            }
            
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
   * 🔥 SEM INSTALAÇÃO DE WORDPRESS - APENAS CLOUDFLARE E CPANEL
   */
  async processPostPurchase(domain, userId, sessionId, trafficSource = null, plataforma = null, isManual = false) {
    try {
      console.log(`🔧 [POST-PURCHASE] Iniciando configurações para ${domain}`);
      if (trafficSource) {
        console.log(`   Fonte de Tráfego: ${trafficSource}`);
      }
      if (plataforma) {
        console.log(`   Plataforma: ${plataforma}`);
      }
      
      let cloudflareSetup = null;
      let isCancelled = false;
      
      // ⚠️ CHECKPOINT: Verificar cancelamento antes do Cloudflare
      if (await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL] Processo cancelado antes do Cloudflare - pulando configurações`);
        isCancelled = true;
      }
      
      // ========================
      // ETAPA 1: CLOUDFLARE (só se não cancelado)
      // ========================
      if (!isCancelled) {
        await this.updateProgress(sessionId, 'cloudflare', 'in_progress', 
          `Configurando Cloudflare para ${domain}...`, domain);
        cloudflareSetup = await this.setupCloudflare(domain);
        
        if (cloudflareSetup) {
          // ⚠️ CHECKPOINT: Verificar cancelamento antes dos nameservers
          if (await this.isSessionCancelled(sessionId)) {
            console.log(`🛑 [CANCEL] Processo cancelado antes dos nameservers`);
            isCancelled = true;
          }
          
          if (!isCancelled) {
            // ETAPA 2: NAMESERVERS
            await this.updateProgress(sessionId, 'nameservers', 'in_progress', 
              `Alterando nameservers de ${domain}...`, domain);
            await this.setNameservers(domain, cloudflareSetup.nameservers);
          }
        }
        
        console.log(`✅ [CLOUDFLARE] Configuração concluída - prosseguindo para cPanel`);
      }
      
      // ⚠️ CHECKPOINT: Verificar cancelamento antes do cPanel
      if (!isCancelled && await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL] Processo cancelado antes do cPanel`);
        isCancelled = true;
      }
      
      // ========================
      // ETAPA 3: CPANEL (só se não cancelado)
      // ========================
      if (!isCancelled) {
        console.log(`🖥️ [CPANEL] Adicionando domínio ao cPanel...`);
        await this.updateProgress(sessionId, 'cpanel', 'in_progress', 
          `Adicionando ${domain} ao cPanel...`, domain);
        
        const cpanelSuccess = await this.addDomainToCPanel(domain);
        
        if (!cpanelSuccess) {
          console.error(`❌ [CPANEL] Falha ao adicionar domínio`);
          await this.updateProgress(sessionId, 'cpanel', 'error', 
            `Erro ao adicionar ${domain} ao cPanel`, domain);
          // Continua para salvar no Supabase mesmo assim
        } else {
          await this.updateProgress(sessionId, 'cpanel', 'completed', 
            `Domínio ${domain} adicionado ao cPanel com sucesso!`, domain);
          console.log(`✅ [CPANEL] Domínio adicionado com sucesso`);
        }
      }
      
      // ========================
      // ETAPA 4: SUPABASE (SEMPRE EXECUTA - mesmo se cancelado)
      // O domínio foi comprado, precisa estar no banco!
      // ========================
      console.log(`💾 [SUPABASE] Salvando domínio no banco de dados...`);
      await this.updateProgress(sessionId, 'supabase', 'in_progress', 
        `Salvando informações de ${domain}...`, domain);
      
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource, plataforma);
      
      if (savedDomain?.id) {
        await this.updateProgress(sessionId, 'supabase', 'completed', 
          `Domínio ${domain} salvo no banco de dados!`, domain);
        
        // ========================
        // ETAPA 5: LOG
        // ========================
        console.log(`📝 [LOG] Registrando atividade...`);
        await this.saveActivityLog(savedDomain.id, userId, trafficSource, isManual);
      } else {
        await this.updateProgress(sessionId, 'supabase', 'error', 
          `Erro ao salvar ${domain} no banco de dados`, domain);
      }
      
      // ========================
      // ETAPA 6: WHATSAPP
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
    
    // ETAPA 1: Criar Custom Hostname no servidor principal
    console.log(`🏷️ [CLOUDFLARE] Criando Custom Hostname...`);
    try {
      await axios.post(
        `${this.cloudflareAPI}/zones/${config.CLOUDFLARE_MAIN_ZONE_ID}/custom_hostnames`,
        {
          hostname: domain,
          ssl: {
            method: 'http',
            type: 'dv'
          }
        },
        {
          headers: {
            'X-Auth-Email': config.CLOUDFLARE_EMAIL,
            'X-Auth-Key': config.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`✅ [CLOUDFLARE] Custom Hostname criado`);
    } catch (error) {
      console.error(`⚠️ [CLOUDFLARE] Erro Custom Hostname:`, error.message);
    }
    
    await this.delay(2000);
    
    // ETAPA 2: Criar zona na Cloudflare
    console.log(`📝 [CLOUDFLARE] Criando zona...`);
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
    const nameservers = zoneResponse.data.result.name_servers;
    
    console.log(`✅ [CLOUDFLARE] Zona criada - ID: ${zoneId}`);
    console.log(`   Nameservers: ${nameservers.join(', ')}`);
    
    await this.delay(2000);
    
    // ETAPA 3: Configurar SSL Full
    console.log(`🔒 [CLOUDFLARE] Configurando SSL Full...`);
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
      console.log(`✅ [CLOUDFLARE] SSL Full configurado`);
    } catch (error) {
      console.error(`⚠️ [CLOUDFLARE] Erro SSL:`, error.message);
    }
    
    await this.delay(2000);
    
    // ETAPA 4: Criar registro CNAME
    console.log(`📍 [CLOUDFLARE] Criando DNS CNAME...`);
    try {
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
        {
          type: 'CNAME',
          name: domain,
          content: config.HOSTING_SERVER_HOSTNAME || 'servidor.institutoexperience.com.br',
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
      console.log(`✅ [CLOUDFLARE] DNS CNAME criado`);
    } catch (error) {
      console.error(`⚠️ [CLOUDFLARE] Erro DNS CNAME:`, error.message);
    }

    await this.delay(2000);

    // ETAPA 5: Criar CNAME track (RedTrack)
    console.log(`📍 [CLOUDFLARE] Criando CNAME track...`);
    try {
      await axios.post(
        `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
        {
          type: 'CNAME',
          name: 'track',
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
      console.log(`✅ [CLOUDFLARE] CNAME track criado`);
    } catch (error) {
      console.error(`⚠️ [CLOUDFLARE] Erro CNAME track:`, error.message);
    }
    
    await this.delay(2000);
    
    // ETAPA 6: Criar Filtro WAF - Sitemap
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
    
    // ETAPA 7: Criar Regra de Bloqueio - Sitemap
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
    
    // ETAPA 8: Criar Filtro WAF - ?s=
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
    
    // ETAPA 9: Criar Regra de Bloqueio - ?s=
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
    console.log(`   Custom Hostname: ${domain}`);
    console.log(`   DNS: CNAME raiz, CNAME track`);
    console.log(`   SSL: Full`);
    console.log(`   WAF: 2 filtros + 2 regras de bloqueio (sitemap, ?s=)`);
    
    return { zoneId: zoneId, nameservers: nameservers };
    
  } catch (error) {
    console.error('❌ [CLOUDFLARE] Erro geral:', error.message);
    return null;
  }
}

 /**
 * ADICIONAR DOMÍNIO AO CPANEL
 * CORRIGIDO: Usando API 2 (json-api) que funciona neste cPanel
 */
async addDomainToCPanel(domain) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🖥️ [CPANEL] ADICIONANDO DOMÍNIO AO CPANEL`);
  console.log(`   Domain: ${domain}`);
  console.log(`${'='.repeat(70)}`);
  
  try {
    // Configurações do domínio
    const domainParts = domain.split('.');
    const subdomain = domainParts[0];
    const dir = domain.replace(/\./g, '_');
    
    console.log(`📋 [CPANEL] Configuração:`);
    console.log(`   Domain completo: ${domain}`);
    console.log(`   Subdomain: ${subdomain}`);
    console.log(`   Diretório: ${dir}`);
    
    // Tentativas com retry
    for (let attempt = 1; attempt <= 5; attempt++) {
      console.log(`\n🔄 [CPANEL] Tentativa ${attempt}/5`);
      
      try {
        // API 2 - Formato correto para este cPanel
        const params = new URLSearchParams({
          cpanel_jsonapi_apiversion: '2',
          cpanel_jsonapi_module: 'AddonDomain',
          cpanel_jsonapi_func: 'addaddondomain',
          dir: dir,
          newdomain: domain,
          subdomain: subdomain
        });
        
        const apiUrl = `${config.CPANEL_URL}/json-api/cpanel?${params.toString()}`;
        
        console.log(`📤 [CPANEL] Requisição:`);
        console.log(`   URL: ${apiUrl}`);
        console.log(`   Method: GET`);
        
        const response = await axios.get(apiUrl, {
          headers: {
            'Authorization': `cpanel ${config.CPANEL_USERNAME}:${config.CPANEL_API_TOKEN}`
          },
          timeout: 60000,
          httpsAgent: new (require('https').Agent)({
            rejectUnauthorized: false
          })
        });
        
        console.log(`📥 [CPANEL] Resposta recebida:`);
        console.log(`   Status HTTP: ${response.status}`);
        console.log(`   Data:`, JSON.stringify(response.data, null, 2));
        
        // Verificar sucesso na resposta API 2
        const result = response.data?.cpanelresult?.data?.[0];
        
        if (result?.result === 1) {
          console.log(`✅ [CPANEL] Domínio ${domain} adicionado com sucesso!`);
          console.log(`   Motivo: ${result.reason || 'Sucesso'}`);
          await this.delay(5000);
          return true;
        }
        
        // Verificar se domínio já existe
        const reason = result?.reason || '';
        if (reason.toLowerCase().includes('already') || 
            reason.toLowerCase().includes('existe') ||
            reason.toLowerCase().includes('exist') ||
            reason.toLowerCase().includes('já')) {
          console.log(`✅ [CPANEL] Domínio já existe - considerando sucesso`);
          await this.delay(5000);
          return true;
        }
        
        console.error(`❌ [CPANEL] Tentativa ${attempt} falhou`);
        console.error(`   Reason: ${reason}`);
        
        if (attempt < 5) {
          const waitTime = attempt * 6000;
          console.log(`⏳ [CPANEL] Aguardando ${waitTime/1000}s...`);
          await this.delay(waitTime);
        }
        
      } catch (error) {
        console.error(`❌ [CPANEL] Erro na tentativa ${attempt}:`);
        console.error(`   Mensagem: ${error.message}`);
        console.error(`   Code: ${error.code || 'N/A'}`);
        
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
        }
        
        if (attempt < 5) {
          const waitTime = attempt * 6000;
          console.log(`⏳ [CPANEL] Aguardando ${waitTime/1000}s...`);
          await this.delay(waitTime);
        }
      }
    }
    
    console.error(`\n❌ [CPANEL] FALHA TOTAL após 5 tentativas - Domínio: ${domain}`);
    return false;
    
  } catch (error) {
    console.error(`❌ [CPANEL] Erro fatal:`, error.message);
    return false;
  }
}
  /**
   * SALVAR NO SUPABASE
   */
  async saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource = null, plataforma = null) {
    try {
      console.log(`💾 [SUPABASE] Buscando informações completas antes de salvar...`);
      
      const namecheapInfo = await this.getDomainInfoFromNamecheap(domain);
      
      const currentDate = new Date().toISOString();
      
      let expirationDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      if (namecheapInfo?.expiration_date) {
        expirationDate = new Date(namecheapInfo.expiration_date).toISOString();
      }
      
      // Payload para a função RPC (sem traffic_source e platform)
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
      
      console.log(`💾 [SUPABASE] Salvando domínio...`);
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE] Erro:', error);
        return null;
      }
      
      console.log('✅ [SUPABASE] Domínio salvo com sucesso');
      
      // A função RPC retorna uma TABLE, então data é um array
      // Usar o domain_id do resultado se disponível
      let domainId = null;
      
      if (data && Array.isArray(data) && data.length > 0) {
        domainId = data[0].domain_id;
        console.log(`✅ [SUPABASE] Domain ID (do RPC): ${domainId}`);
      }
      
      // Se não conseguiu do RPC, buscar pelo domain_name (sem filtrar por user_id)
      if (!domainId) {
        const { data: domainData, error: fetchError } = await supabase
          .from('domains')
          .select('id')
          .eq('domain_name', domain)
          .single();
        
        if (fetchError) {
          console.error('⚠️ [SUPABASE] Erro ao buscar domain_id:', fetchError.message);
          return null;
        }
        
        domainId = domainData.id;
        console.log(`✅ [SUPABASE] Domain ID (da busca): ${domainId}`);
      }
      
      // Criar objeto para retorno compatível
      const domainData = { id: domainId };
      
      // Atualizar traffic_source e platform separadamente se fornecidos
      const updateFields = {};
      if (trafficSource) {
        updateFields.traffic_source = trafficSource;
      }
      if (plataforma) {
        updateFields.platform = plataforma;
      }
      
      if (Object.keys(updateFields).length > 0) {
        console.log(`💾 [SUPABASE] Atualizando campos adicionais:`, updateFields);
        const { error: updateError } = await supabase
          .from('domains')
          .update(updateFields)
          .eq('id', domainData.id);
        
        if (updateError) {
          console.error('⚠️ [SUPABASE] Erro ao atualizar campos:', updateError.message);
        } else {
          if (trafficSource) {
            console.log(`✅ [SUPABASE] Fonte de tráfego atualizada: ${trafficSource}`);
          }
          if (plataforma) {
            console.log(`✅ [SUPABASE] Plataforma atualizada: ${plataforma}`);
          }
        }
      }
      
      return domainData;
      
    } catch (error) {
      console.error('❌ [SUPABASE] Erro:', error.message);
      return null;
    }
  }

  /**
   * REGISTRAR LOG
   */
  async saveActivityLog(domainId, userId, trafficSource = null, isManual = false) {
  try {
    console.log(`📝 [LOG] Registrando atividade para domínio ${domainId}...`);
    
    let newValue = isManual 
      ? 'Domínio comprado manualmente - WordPress' 
      : 'Domínio comprado com IA - WordPress';
    if (trafficSource) {
      newValue += ` | Fonte de Tráfego: ${trafficSource}`;
    }
      
      const { error } = await supabase
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
        return;
      }
      
      console.log('✅ [LOG] Atividade registrada com sucesso');
      
    } catch (error) {
      console.error('❌ [LOG] Erro:', error.message);
    }
  }

  /**
   * NOTIFICAR WHATSAPP
   */
  async sendWhatsAppNotification(domain, status, errorMsg = '') {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ [WHATSAPP-WORDPRESS] ZAPI não configurado');
      return;
    }
    
    try {
      const phoneNumber = config.WHATSAPP_PHONE_NUMBER;
      
      // Data e hora formatadas separadamente
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
      
      // MENSAGEM - ATUALIZADA SEM WORDPRESS
      let message;
      if (status === 'success') {
        message = `🤖 *Domain Hub*\n\n` +
          `Lerricke, um novo domínio foi criado ✅:\n\n` +
          `🌐Domínio: ${domain}\n` +
          `🛜 Plataforma : Wordpress\n` +
          `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;
      } else {
        message = `🤖 *Domain Hub*\n\n` +
          `Lerricke, houve um erro ao criar o domínio ❌:\n\n` +
          `🌐Domínio tentado: ${domain}\n` +
          `❌Erro: ${errorMsg}\n` +
          `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;
      }
      
      console.log(`📱 [WHATSAPP-WORDPRESS] Enviando para: ${phoneNumber}`);
      console.log(`   Mensagem: ${message.substring(0, 50)}...`);
      const zapiUrl = config.ZAPI_INSTANCE;
      
      console.log(`🌐 [WHATSAPP-WORDPRESS] URL: ${zapiUrl}`);
      
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
      
      console.log('✅ [WHATSAPP-WORDPRESS] Notificação enviada com sucesso');
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));
      
    } catch (error) {
      console.error('❌ [WHATSAPP-WORDPRESS] Erro ao enviar:', error.message);
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
      
      console.log(`📊 [PROGRESS] ${step} - ${status} - ${message}`);
      
    } catch (error) {
      console.error('❌ [PROGRESS] Erro:', error.message);
    }
  }

  /**
   * BUSCAR INFORMAÇÕES DO DOMÍNIO NA NAMECHEAP
   */
  async getDomainInfoFromNamecheap(domain) {
    try {
      console.log(`📋 [NAMECHEAP] Buscando informações de ${domain}...`);
      
      const domainParts = domain.split('.');
      const tld = domainParts.pop();
      const sld = domainParts.join('.');
      
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
        console.error(`❌ [NAMECHEAP] Erro ao buscar info de ${domain}`);
        return null;
      }
      
      const info = {};
      
      const createdMatch = xmlData.match(/CreatedDate="([^"]+)"/);
      if (createdMatch) {
        info.created_date = createdMatch[1];
      }
      
      const expiresMatch = xmlData.match(/ExpiredDate="([^"]+)"/);
      if (expiresMatch) {
        info.expiration_date = expiresMatch[1];
      }
      
      const statusMatch = xmlData.match(/Status="([^"]+)"/);
      if (statusMatch) {
        info.status = statusMatch[1];
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