/**
 * COMPRA DE DOMÍNIOS ATOMICAT - VERSÃO FINAL COMPLETA
 */

const axios = require('axios');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');

// Inicializar Supabase
const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_KEY
);

// Cache global de sessões canceladas (compartilhado entre instâncias)
const cancelledSessions = new Set();

class AtomiCatDomainPurchase {
  constructor() {
    // Configurações de APIs
    this.namecheapAPI = 'https://api.namecheap.com/xml.response';
    this.openaiAPI = 'https://api.openai.com/v1/chat/completions';
    
    // Configurações de compra
    this.maxRetries = 10;
    this.priceLimit = 5.00;
    
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
   */
  async isSessionCancelled(sessionId) {
    // Verificar cache local primeiro
    if (cancelledSessions.has(sessionId)) {
      console.log(`🛑 [CANCEL-ATOMICAT] Sessão ${sessionId} encontrada no cache de cancelados`);
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
        cancelledSessions.add(sessionId);
        console.log(`🛑 [CANCEL-ATOMICAT] Sessão ${sessionId} cancelada (Supabase)`);
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
    console.log(`🛑 [CANCEL-ATOMICAT] Sessão ${sessionId} marcada como cancelada`);
  }

  /**
   * FUNÇÃO PRINCIPAL - APENAS COMPRA (SEM CLOUDFLARE/WORDPRESS)
   */
  async purchaseDomain(params) {
    const { quantidade, idioma, nicho, sessionId, domainManual, userId, trafficSource, plataforma, isManual } = params;
    
    console.log(`🚀 [ATOMICAT] Iniciando compra`);
    console.log(`   Usuário: ${userId}`);
    console.log(`   Manual: ${domainManual ? 'SIM' : 'NÃO'}`);
    console.log(`   Sem limite de preço: ${isManual ? 'SIM' : 'NÃO'}`);
    if (trafficSource) {
      console.log(`   Fonte de Tráfego: ${trafficSource}`);
    }
    if (plataforma) {
      console.log(`   Plataforma: ${plataforma}`);
    }
    console.log(`   ⚠️ MODO ATOMICAT: Apenas compra (sem Cloudflare/WordPress)`);
    
    await this.updateProgress(sessionId, 'generating', 'in_progress', 'Iniciando processo AtomiCat...');
    
    const domainsToRegister = [];
    let successCount = 0;
    
    // Se for compra manual
    if (domainManual) {
      console.log(`🔍 [MANUAL-ATOMICAT] Processando: ${domainManual}`);
      
      // ⚠️ CHECKPOINT: Verificar cancelamento antes de verificar disponibilidade
      if (await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL-ATOMICAT] Processo cancelado antes da verificação`);
        await this.updateProgress(sessionId, 'canceled', 'canceled', 'Compra cancelada pelo usuário');
        return { success: false, error: 'Compra cancelada pelo usuário', cancelled: true };
      }
      
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
        console.log(`💰 [MANUAL-ATOMICAT] Preço do domínio: $${availabilityCheck.price} (sem limite de preço)`);
      }
      
      // ⚠️ CHECKPOINT: Verificar cancelamento antes de comprar
      if (await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL-ATOMICAT] Processo cancelado antes da compra`);
        await this.updateProgress(sessionId, 'canceled', 'canceled', 'Compra cancelada pelo usuário');
        return { success: false, error: 'Compra cancelada pelo usuário', cancelled: true };
      }
      
      const purchaseResult = await this.purchaseDomainNamecheap(domainManual, isManual);
      
      if (purchaseResult.success) {
        domainsToRegister.push(domainManual);
        successCount = 1;
        
        // ✅ CRÍTICO: Notificar frontend IMEDIATAMENTE que o domínio foi comprado
        await this.updateProgress(sessionId, 'purchasing', 'completed', 
          `Domínio ${domainManual} comprado com sucesso!`, domainManual);
        
        // Processar pós-compra com fonte de tráfego, sessionId, plataforma e PREÇO
        await this.processPostPurchase(domainManual, userId, sessionId, trafficSource, plataforma, true, availabilityCheck.price);
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
          console.log(`🛑 [CANCEL-ATOMICAT] Processo cancelado no início da iteração ${i + 1}`);
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
              console.log(`🛑 [CANCEL-ATOMICAT] Processo cancelado durante retry ${retries}`);
              throw new Error('CANCELLED');
            }
            
            console.log(`🤖 [AI-ATOMICAT] Gerando domínio genérico ${i + 1}/${quantidade} (tentativa ${retries + 1})`);
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
            
            // ⚠️ CHECKPOINT: Verificar cancelamento antes de comprar
            if (await this.isSessionCancelled(sessionId)) {
              console.log(`🛑 [CANCEL-ATOMICAT] Processo cancelado antes de comprar ${generatedDomain}`);
              throw new Error('CANCELLED');
            }
            
            console.log(`💳 Comprando: ${generatedDomain} por $${availabilityCheck.price}`);
            await this.updateProgress(sessionId, 'purchasing', 'in_progress', 
              `Comprando ${generatedDomain}...`);
            
            const purchaseResult = await this.purchaseDomainNamecheap(generatedDomain, false);
            
            if (purchaseResult.success) {
              domain = generatedDomain;
              domainsToRegister.push(domain);
              successCount++;
              
              console.log(`✅ [ATOMICAT] Domínio comprado: ${domain}`);
              console.log(`   ⚠️ Cloudflare e WordPress NÃO configurados (modo AtomiCat)`);
              
              // ✅ CRÍTICO: Notificar frontend IMEDIATAMENTE que o domínio foi comprado
              await this.updateProgress(sessionId, 'purchasing', 'completed', 
                `Domínio ${generatedDomain} comprado com sucesso!`, generatedDomain);
              
              // Processar pós-compra com sessionId, trafficSource, plataforma e PREÇO
              await this.processPostPurchase(domain, userId, sessionId, trafficSource, plataforma, false, availabilityCheck.price);
              
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
            // Se foi cancelado, sair do loop
            if (error.message === 'CANCELLED') {
              console.log(`🛑 [CANCEL-ATOMICAT] Loop interrompido por cancelamento`);
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
          console.error(`❌ Não foi possível comprar o domínio ${i + 1} após ${this.maxRetries} tentativas`);
        }
      }
    }
    
    // Callback final - SÓ SE REALMENTE COMPROU
    if (successCount > 0) {
      await this.updateProgress(sessionId, 'completed', 'completed', 
        `${successCount} domínio(s) AtomiCat comprado(s)!`, 
        domainsToRegister[domainsToRegister.length - 1]);
      
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
   * PROCESSAR PÓS-COMPRA
   * - Buscar informações do domínio na Namecheap
   * - Salvar no Supabase com dados reais
   * - Salvar log de atividade
   * - Enviar notificação WhatsApp
   */
  async processPostPurchase(domain, userId, sessionId = null, trafficSource = null, plataforma = null, isManual = false, purchasePrice = null) {
    try {
      console.log(`🔧 [POST-PURCHASE-ATOMICAT] Iniciando para ${domain}`);
      if (trafficSource) {
        console.log(`   Fonte de Tráfego: ${trafficSource}`);
      }
      if (plataforma) {
        console.log(`   Plataforma: ${plataforma}`);
      }
      if (purchasePrice) {
        console.log(`   💰 Preço de compra: $${purchasePrice}`);
      }
      
      // Aguardar 5 segundos para domínio ser processado na Namecheap
      console.log(`⏳ [POST-PURCHASE-ATOMICAT] Aguardando 5s para processar...`);
      await this.delay(5000);
      
      // Buscar informações do domínio na Namecheap
      const namecheapInfo = await this.getDomainInfoFromNamecheap(domain);
      
      // Salvar no Supabase com dados reais, fonte de tráfego, plataforma e preço
      const savedDomain = await this.saveDomainToSupabase(domain, userId, namecheapInfo, trafficSource, plataforma, purchasePrice);
      
      // Salvar log de atividade
      if (savedDomain?.id) {
  await this.saveActivityLog(savedDomain.id, userId, trafficSource, isManual);
  }
      
      // Enviar notificação WhatsApp
      await this.sendWhatsAppNotification(domain, 'success');
      
      console.log(`✅ [POST-PURCHASE-ATOMICAT] Concluído para ${domain}`);
      
    } catch (error) {
      console.error(`❌ [POST-PURCHASE-ATOMICAT] Erro:`, error.message);
      await this.sendWhatsAppNotification(domain, 'error', error.message);
    }
  }

  /**
   * VERIFICAR DISPONIBILIDADE E PREÇO - NAMECHEAP
   */
  async checkDomainAvailability(domain) {
    if (!config.NAMECHEAP_API_KEY || !config.NAMECHEAP_API_USER) {
      console.error('❌ [NAMECHEAP-ATOMICAT] API não configurada!');
      return { available: false, error: 'Namecheap API não configurada' };
    }

    try {
      // ═══════════════════════════════════════════════════════════════
      // TRAVA DE SEGURANÇA: Verificar se domínio já existe no banco
      // Evita comprar/renovar domínios que já são nossos
      // ═══════════════════════════════════════════════════════════════
      const { data: existingDomain } = await supabase
        .from('domains')
        .select('id, status, domain_name')
        .eq('domain_name', domain)
        .maybeSingle();

      if (existingDomain) {
        console.log(`🚫 [DUPLICATA] Domínio ${domain} já existe no banco (status: ${existingDomain.status})`);
        return { available: false, error: `Domínio já existe no sistema (status: ${existingDomain.status})` };
      }
      // ═══════════════════════════════════════════════════════════════

      console.log(`🔍 [NAMECHEAP-ATOMICAT] Verificando: ${domain}...`);
      
      const checkParams = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.check',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        DomainList: domain
      };
      
      const checkResponse = await axios.get(this.namecheapAPI, { params: checkParams, timeout: 15000 });
      const checkXml = checkResponse.data;
      
      // DEBUG: Ver XML
      console.log(`🔍 [NAMECHEAP-ATOMICAT DEBUG] XML (primeiros 500 chars):`);
      console.log(checkXml.substring(0, 500));
      
      // Extrair o bloco DomainCheckResult
      const domainResultMatch = checkXml.match(/<DomainCheckResult[^>]*>/i);
      
      if (!domainResultMatch) {
        console.error('❌ [NAMECHEAP-ATOMICAT] DomainCheckResult não encontrado');
        return { available: false, error: 'Resposta inválida da API' };
      }
      
      const resultBlock = domainResultMatch[0];
      console.log(`🔍 [NAMECHEAP-ATOMICAT DEBUG] Bloco: ${resultBlock}`);
      
      // Extrair Available do bloco correto
      const availableMatch = resultBlock.match(/Available="([^"]+)"/i);
      const isAvailable = availableMatch && availableMatch[1].toLowerCase() === 'true';
      
      // Verificar se é premium
      const isPremiumMatch = resultBlock.match(/IsPremiumName="([^"]+)"/i);
      const isPremium = isPremiumMatch && isPremiumMatch[1].toLowerCase() === 'true';
      
      let price = 0.99;
      
      if (isPremium) {
        const premiumPriceMatch = resultBlock.match(/PremiumRegistrationPrice="([^"]+)"/i);
        if (premiumPriceMatch && parseFloat(premiumPriceMatch[1]) > 0) {
          price = parseFloat(premiumPriceMatch[1]);
        }
      } else {
        const tld = domain.split('.').pop().toLowerCase();
        
        try {
          const pricingParams = {
            ApiUser: config.NAMECHEAP_API_USER,
            ApiKey: config.NAMECHEAP_API_KEY,
            UserName: config.NAMECHEAP_API_USER,
            Command: 'namecheap.users.getPricing',
            ClientIp: config.NAMECHEAP_CLIENT_IP,
            ProductType: 'DOMAIN',
            ProductCategory: 'REGISTER',
            ProductName: tld
          };
          
          const pricingResponse = await axios.get(this.namecheapAPI, { params: pricingParams, timeout: 15000 });
          const pricingXml = pricingResponse.data;
          
          // IMPORTANTE: Buscar especificamente na categoria "register"
          const registerCategoryMatch = pricingXml.match(/<ProductCategory Name="register">([\s\S]*?)<\/ProductCategory>/i);
          
          if (registerCategoryMatch) {
            const registerBlock = registerCategoryMatch[1];
            
            // Buscar YourPrice dentro do bloco de register (Duration="1" para 1 ano)
            const yourPriceMatch = registerBlock.match(/Duration="1"[^>]*YourPrice="([0-9.]+)"/);
            if (yourPriceMatch && parseFloat(yourPriceMatch[1]) > 0) {
              price = parseFloat(yourPriceMatch[1]);
            } else {
              // Fallback: Price normal no bloco register
              const priceMatch = registerBlock.match(/Duration="1"[^>]*Price="([0-9.]+)"/);
              if (priceMatch && parseFloat(priceMatch[1]) > 0) {
                price = parseFloat(priceMatch[1]);
              }
            }
            
            // ═══════════════════════════════════════════════════════════════
            // ICANN FEE: Extrair taxa adicional (ICANN fee) automaticamente
            // A Namecheap retorna "YourAdditonalCost" (com typo deles) no XML
            // Isso garante que se o valor mudar, o sistema pega automaticamente
            // ═══════════════════════════════════════════════════════════════
            const icannMatch = registerBlock.match(/Duration="1"[^>]*YourAdditonalCost="([0-9.]+)"/);
            if (!icannMatch) {
              const icannMatchAlt = registerBlock.match(/Duration="1"[^>]*YourAdditionalCost="([0-9.]+)"/);
              if (icannMatchAlt && parseFloat(icannMatchAlt[1]) > 0) {
                const icannFee = parseFloat(icannMatchAlt[1]);
                price = parseFloat((price + icannFee).toFixed(2));
                console.log(`✅ [PRICING-ATOMICAT] ICANN fee: $${icannFee} | Preço total: $${price}`);
              }
            } else if (parseFloat(icannMatch[1]) > 0) {
              const icannFee = parseFloat(icannMatch[1]);
              price = parseFloat((price + icannFee).toFixed(2));
              console.log(`✅ [PRICING-ATOMICAT] ICANN fee: $${icannFee} | Preço total: $${price}`);
            }
            // ═══════════════════════════════════════════════════════════════
            
          } else {
            // Fallback antigo caso categoria não seja encontrada
            const priceMatch = pricingXml.match(/Duration="1"[^>]*Price="([^"]+)"/);
            if (priceMatch) {
              price = parseFloat(priceMatch[1]);
            }
            
            // Tentar pegar ICANN fee mesmo no fallback
            const icannFallback = pricingXml.match(/YourAdditonalCost="([0-9.]+)"/);
            if (!icannFallback) {
              const icannFallbackAlt = pricingXml.match(/YourAdditionalCost="([0-9.]+)"/);
              if (icannFallbackAlt && parseFloat(icannFallbackAlt[1]) > 0) {
                const icannFee = parseFloat(icannFallbackAlt[1]);
                price = parseFloat((price + icannFee).toFixed(2));
              }
            } else if (parseFloat(icannFallback[1]) > 0) {
              const icannFee = parseFloat(icannFallback[1]);
              price = parseFloat((price + icannFee).toFixed(2));
            }
          }
        } catch (pricingError) {
          console.log(`⚠️ [NAMECHEAP-ATOMICAT] Erro pricing: ${pricingError.message}`);
        }
      }

      console.log(`📊 [NAMECHEAP-ATOMICAT] ${domain}`);
      console.log(`   Disponível: ${isAvailable ? '✅ SIM' : '❌ NÃO'}`);
      console.log(`   Premium: ${isPremium ? 'SIM' : 'NÃO'}`);
      console.log(`   Preço: $${price.toFixed(2)}`);
      
      return {
        available: isAvailable,
        price: price,
        definitive: true,
        isPremium: isPremium
      };

    } catch (error) {
      console.error('❌ [NAMECHEAP-ATOMICAT] Erro:', error.message);
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
   * COMPRAR DOMÍNIO NA NAMECHEAP
   */
  async purchaseDomainNamecheap(domain, isManual = false) {
    try {
      console.log(`💳 [NAMECHEAP-ATOMICAT] Comprando: ${domain}`);
      
      // Validar formato
      if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
        console.error(`❌ [NAMECHEAP] Formato inválido: ${domain}`);
        return { success: false, error: 'Formato de domínio inválido' };
      }
      
      // Validar que termina com .online APENAS para compra com IA (não manual)
      if (!isManual && !domain.endsWith('.online')) {
        console.error(`❌ [NAMECHEAP] Domínio deve terminar com .online: ${domain}`);
        return { success: false, error: 'Domínio deve terminar com .online' };
      }
      
      // Validar caracteres (apenas letras e números antes do .online)
      const domainParts = domain.split('.');
      const domainName = domainParts.slice(0, -1).join('');
      if (!/^[a-z0-9]+$/i.test(domainName)) {
        console.error(`❌ [NAMECHEAP] Caracteres inválidos: ${domainName  }`);
        return { success: false, error: 'Domínio com caracteres inválidos' };
      }
      
      console.log(`📝 [NAMECHEAP-ATOMICAT] Enviando domínio completo: ${domain}`);
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.create',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        DomainName: domain,
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
      
      console.log(`📤 [NAMECHEAP-ATOMICAT] Enviando requisição...`);
      
      const response = await axios.get(this.namecheapAPI, { params, timeout: 30000 });
      const xmlData = response.data;
      
      // VERIFICAR ERROS NO XML (como no N8N)
      const hasError = xmlData.includes('ERROR') || xmlData.includes('Status="ERROR"');
      
      if (hasError) {
        console.error(`❌ [NAMECHEAP-ATOMICAT] Status ERROR detectado`);
        
        // Extrair mensagem de erro
        const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
        if (errorMatch) {
          const errorMessage = errorMatch[1];
          console.error(`❌ [NAMECHEAP-ATOMICAT] Erro: ${errorMessage}`);
          return { success: false, error: errorMessage };
        }
        
        // Se não encontrou padrão específico, mostrar XML
        console.error(`📄 [NAMECHEAP-ATOMICAT] XML com erro (primeiros 1000 chars):`);
        console.error(xmlData.substring(0, 1000));
        return { success: false, error: 'Erro na compra - verifique logs' };
      }
      
      // VERIFICAR SUCESSO
      if (xmlData.includes('Status="OK"') && xmlData.includes('DomainCreate')) {
        // Extrair nome do domínio comprado do XML
        const domainMatch = xmlData.match(/Domain="([^"]+)"/);
        const purchasedDomain = domainMatch ? domainMatch[1] : domain;
        
        console.log(`✅ [NAMECHEAP-ATOMICAT] Domínio ${purchasedDomain} comprado com sucesso!`);
        return { success: true, domain: purchasedDomain };
      }
      
      // Resposta inesperada
      console.error(`❌ [NAMECHEAP-ATOMICAT] Resposta inesperada`);
      console.error(`📄 [NAMECHEAP-ATOMICAT] XML (primeiros 1000 chars):`);
      console.error(xmlData.substring(0, 1000));
      return { success: false, error: 'Resposta inesperada' };
      
    } catch (error) {
      console.error(`❌ [NAMECHEAP-ATOMICAT] Erro:`, error.message);
      if (error.response) {
        console.error(`   Status HTTP: ${error.response.status}`);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * BUSCAR INFORMAÇÕES DO DOMÍNIO NA NAMECHEAP
   */
  async getDomainInfoFromNamecheap(domain) {
    try {
      console.log(`🔍 [NAMECHEAP-INFO] Buscando informações de ${domain}...`);
      
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
      
      // Extrair informações do XML
      const info = {};
      
      // Data de criação
      const createdDateMatch = xmlData.match(/CreatedDate="([^"]+)"/);
      if (createdDateMatch) {
        info.created_date = createdDateMatch[1];
      }
      
      // Data de expiração
      const expiresMatch = xmlData.match(/Expires="([^"]+)"/);
      if (expiresMatch) {
        info.expiration_date = expiresMatch[1];
      }
      
      // Status
      const statusMatch = xmlData.match(/Status="([^"]+)"/);
      if (statusMatch) {
        info.status = statusMatch[1];
      }
      
      // WhoisGuard
      const whoisGuardMatch = xmlData.match(/WhoisGuard="([^"]+)"/);
      if (whoisGuardMatch) {
        info.whois_guard = whoisGuardMatch[1] === 'ENABLED';
      }
      
      // AutoRenew
      const autoRenewMatch = xmlData.match(/AutoRenew="([^"]+)"/);
      if (autoRenewMatch) {
        info.auto_renew = autoRenewMatch[1] === 'true';
      }
      
      console.log(`✅ [NAMECHEAP-INFO] Informações obtidas:`);
      console.log(`   Criado: ${info.created_date || 'N/A'}`);
      console.log(`   Expira: ${info.expiration_date || 'N/A'}`);
      console.log(`   Status: ${info.status || 'N/A'}`);
      console.log(`   AutoRenew: ${info.auto_renew ? 'SIM' : 'NÃO'}`);
      
      return info;
      
    } catch (error) {
      console.error(`⚠️ [NAMECHEAP-INFO] Erro ao buscar info:`, error.message);
      return null;
    }
  }

  /**
   * SALVAR NO SUPABASE - VERSÃO MELHORADA
   * Usa informações REAIS da Namecheap
   */
  async saveDomainToSupabase(domain, userId, namecheapInfo, trafficSource = null, plataforma = null, purchasePrice = null) {
    try {
      console.log(`💾 [SUPABASE-ATOMICAT] Salvando ${domain}...`);
      if (purchasePrice) {
        console.log(`   💰 Preço de compra: $${purchasePrice}`);
      }
      
      const currentDate = new Date().toISOString();
      
      // Usar data de expiração da Namecheap ou calcular 1 ano
      let expirationDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      if (namecheapInfo?.expiration_date) {
        expirationDate = new Date(namecheapInfo.expiration_date).toISOString();
      }
      
      // Usar data de criação da Namecheap ou data atual
      let purchaseDate = currentDate;
      if (namecheapInfo?.created_date) {
        purchaseDate = new Date(namecheapInfo.created_date).toISOString();
      }
      
      // Payload para a função RPC (sem traffic_source e platform)
      const payload = {
        p_user_id: userId || config.SUPABASE_USER_ID,
        p_domain_name: domain,
        p_expiration_date: expirationDate,
        p_purchase_date: purchaseDate,
        p_status: 'active',
        p_registrar: 'Namecheap',
        p_integration_source: 'namecheap',
        p_last_stats_update: currentDate,
        p_nameservers: null,
        p_dns_configured: false,
        p_auto_renew: namecheapInfo?.auto_renew || false
      };
      
      const { data, error } = await supabase.rpc('upsert_domain_stats', payload);
      
      if (error) {
        console.error('❌ [SUPABASE-ATOMICAT] Erro:', error);
        return null;
      }
      
      console.log('✅ [SUPABASE-ATOMICAT] Domínio salvo com dados reais');
      
      // A função RPC retorna uma TABLE, então data é um array
      // Usar o domain_id do resultado se disponível
      let domainId = null;
      
      if (data && Array.isArray(data) && data.length > 0) {
        domainId = data[0].domain_id;
        console.log(`✅ [SUPABASE-ATOMICAT] Domain ID (do RPC): ${domainId}`);
      }
      
      // Se não conseguiu do RPC, buscar pelo domain_name (sem filtrar por user_id)
      if (!domainId) {
        const { data: fetchedDomain, error: fetchError } = await supabase
          .from('domains')
          .select('id')
          .eq('domain_name', domain)
          .single();
        
        if (fetchError || !fetchedDomain?.id) {
          console.error('⚠️ [SUPABASE-ATOMICAT] Erro ao buscar domain_id');
          return null;
        }
        
        domainId = fetchedDomain.id;
        console.log(`✅ [SUPABASE-ATOMICAT] Domain ID (da busca): ${domainId}`);
      }
      
      // Criar objeto para retorno compatível
      const domainData = { id: domainId };
      
      // Atualizar traffic_source, platform e purchase_price separadamente se fornecidos
      const updateFields = {};
      if (trafficSource) {
        updateFields.traffic_source = trafficSource;
      }
      if (plataforma) {
        updateFields.platform = plataforma;
      }
      if (purchasePrice !== null && purchasePrice !== undefined) {
        updateFields.purchase_price = purchasePrice;
      }
      
      if (Object.keys(updateFields).length > 0) {
        console.log(`💾 [SUPABASE-ATOMICAT] Atualizando campos adicionais:`, updateFields);
        const { error: updateError } = await supabase
          .from('domains')
          .update(updateFields)
          .eq('id', domainData.id);
        
        if (updateError) {
          console.error('⚠️ [SUPABASE-ATOMICAT] Erro ao atualizar campos:', updateError.message);
        } else {
          if (trafficSource) {
            console.log(`✅ [SUPABASE-ATOMICAT] Fonte de tráfego atualizada: ${trafficSource}`);
          }
          if (plataforma) {
            console.log(`✅ [SUPABASE-ATOMICAT] Plataforma atualizada: ${plataforma}`);
          }
          if (purchasePrice !== null && purchasePrice !== undefined) {
            console.log(`✅ [SUPABASE-ATOMICAT] Preço de compra salvo: $${purchasePrice}`);
          }
        }
      }
      
      return domainData;
      
    } catch (error) {
      console.error('❌ [SUPABASE-ATOMICAT] Erro:', error.message);
      return null;
    }
  }

  /**
   * REGISTRAR LOG DE ATIVIDADE
   */
  async saveActivityLog(domainId, userId, trafficSource = null, isManual = false) {
  try {
    let newValue = isManual 
      ? 'Domínio comprado manualmente - AtomiCat' 
      : 'Domínio comprado com IA - AtomiCat';
    if (trafficSource) {
      newValue += ` | Fonte de Tráfego: ${trafficSource}`;
    }
      
      await supabase
        .from('domain_activity_logs')
        .insert({
          domain_id: domainId,
          user_id: userId || config.SUPABASE_USER_ID,
          action_type: 'created',
          old_value: null,
          new_value: newValue
        });
      
      console.log('✅ [LOG-ATOMICAT] Atividade registrada');
      if (trafficSource) {
        console.log(`   Com fonte de tráfego: ${trafficSource}`);
      }
      
    } catch (error) {
      console.error('❌ [LOG-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * NOTIFICAR WHATSAPP VIA ZAPI
   */
  async sendWhatsAppNotification(domain, status, errorMsg = '') {
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ [WHATSAPP-ATOMICAT] ZAPI não configurado');
      return;
    }
    
    try {
      const phoneNumber = config.WHATSAPP_PHONE_NUMBER;
      
      // Data e hora formatadas separadamente (igual WordPress)
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
      
      // MENSAGEM
      let message;
      if (status === 'success') {
        message = `🤖 *Domain Hub*\n\n` +
          `Lerricke, um novo domínio foi criado ✅:\n\n` +
          `🌐Domínio: ${domain}\n` +
          `🛜 Plataforma : AtomiCat\n` +
          `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;
      } else {
        message = `🤖 *Domain Hub*\n\n` +
          `Lerricke, houve um erro ao criar o domínio ❌:\n\n` +
          `🌐Domínio tentado: ${domain}\n` +
          `❌Erro: ${errorMsg}\n` +
          `🗓️Data: ${dataFormatada} ás ${horaFormatada}`;
      }
      
      console.log(`📱 [WHATSAPP-ATOMICAT] Enviando para: ${phoneNumber}`);
      console.log(`   Mensagem: ${message.substring(0, 50)}...`);
      const zapiUrl = config.ZAPI_INSTANCE;
      
      console.log(`🌐 [WHATSAPP-ATOMICAT] URL: ${zapiUrl}`);
      
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
      
      console.log('✅ [WHATSAPP-ATOMICAT] Notificação enviada com sucesso');
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));
      
    } catch (error) {
      console.error('❌ [WHATSAPP-ATOMICAT] Erro ao enviar:', error.message);
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
          platform: 'atomicat',
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id' });
    } catch (error) {
      console.error('❌ [PROGRESS-ATOMICAT] Erro:', error.message);
    }
  }

  /**
   * VERIFICAR SALDO NA NAMECHEAP
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
      
      console.log(`💰 [ATOMICAT] Saldo Namecheap: $${balance.toFixed(2)}`);
      return balance;
      
    } catch (error) {
      console.error('❌ [ATOMICAT] Erro ao verificar saldo:', error.message);
      return 0;
    }
  }

  /**
   * CONSTRUIR PROMPT PARA IA
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
    3. NUNCA use acentos, cedilha, traços ou caracteres especiais
    4. O domínio deve ser em ${lang}
    5. Inspirado no nicho: ${nicho}
    6. Deve ser adaptável para múltiplos produtos
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

  /**
   * DELAY (HELPER)
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AtomiCatDomainPurchase;
