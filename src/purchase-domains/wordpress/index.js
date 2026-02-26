/**
 * COMPRA DE DOMÍNIOS WORDPRESS 
 * COM CALLBACKS COMPLETOS PARA FRONTEND
 */

const axios = require('axios');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');
const { exec } = require('child_process');
const { promisify } = require('util');
const openpgp = require('openpgp');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

// Importar função de setup do WordPress
const { setupWordPress } = require('./wordpress-install');

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

  // ═══════════════════════════════════════════════════════════════
  // VERIFICAR DISPONIBILIDADE DE CONTAS NO WHM
  // Consulta o WHM para saber se há espaço para criar nova conta
  // ═══════════════════════════════════════════════════════════════
  async checkWHMAccountAvailability() {
    if (!config.WHM_URL || !config.WHM_USERNAME || !config.WHM_API_TOKEN) {
      console.error('❌ [WHM] Variáveis WHM não configuradas - bloqueando compra WordPress');
      return { hasCapacity: false, currentCount: 0, maxLimit: 0, error: 'WHM não configurado' };
    }

    try {
      console.log('📊 [WHM] Verificando limite de contas via acctcounts...');
      
      const response = await axios.get(
        `${config.WHM_URL}/json-api/acctcounts?api.version=1`,
        {
          headers: { 'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}` },
          timeout: 10000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false })
        }
      );

      const acctData = response.data?.data || response.data;
      
      if (!acctData) {
        console.error('❌ [WHM] acctcounts retornou resposta vazia');
        return { hasCapacity: false, currentCount: 0, maxLimit: 0, error: 'Resposta vazia do WHM' };
      }

      const active = parseInt(acctData.active) || 0;
      const suspended = parseInt(acctData.suspended) || 0;
      const limit = parseInt(acctData.limit) || 0;
      const currentCount = active + suspended;

      if (limit > 0) {
        const available = limit - currentCount;
        console.log(`📊 [WHM] Ativas: ${active} | Suspensas: ${suspended} | Total: ${currentCount}/${limit} | Disponíveis: ${available}`);
        return { hasCapacity: available > 0, currentCount, maxLimit: limit, available };
      }

      // limit=0 significa ilimitado no WHM — liberar
      console.log(`📊 [WHM] Ativas: ${active} | Suspensas: ${suspended} | Limite: ilimitado`);
      return { hasCapacity: true, currentCount, maxLimit: 0, available: -1, unlimited: true };

    } catch (error) {
      console.error(`❌ [WHM] Falha ao verificar limite de contas: ${error.message}`);
      return { hasCapacity: false, currentCount: 0, maxLimit: 0, error: `Falha na consulta WHM: ${error.message}` };
    }
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
    
    // ═══════════════════════════════════════════════════════════════
    // TRAVA DE SEGURANÇA: Verificar se há espaço no WHM antes de comprar
    // Evita gastar dinheiro em domínios que não poderão ser configurados
    // ═══════════════════════════════════════════════════════════════
    const whmCheck = await this.checkWHMAccountAvailability();
    
    if (!whmCheck.hasCapacity) {
      const msg = `Limite de contas no WHM atingido (${whmCheck.currentCount}/${whmCheck.maxLimit}). Não é possível criar novas contas no servidor. Libere espaço antes de comprar novos domínios.`;
      console.error(`🚫 [WHM-LIMITE] ${msg}`);
      await this.updateProgress(sessionId, 'error', 'error', msg);
      return { success: false, error: msg, whmLimitReached: true };
    }

    // Se vai comprar múltiplos domínios, ajustar quantidade ao espaço disponível
    let quantidadeAjustada = quantidade;
    if (whmCheck.available > 0 && whmCheck.available < quantidade) {
      console.log(`⚠️ [WHM] Espaço disponível (${whmCheck.available}) menor que quantidade solicitada (${quantidade}). Ajustando...`);
      quantidadeAjustada = whmCheck.available;
    }
    // ═══════════════════════════════════════════════════════════════
    
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
        
        // Processar todas as configurações (incluindo plataforma e PREÇO)
        await this.processPostPurchase(domainManual, userId, sessionId, trafficSource, plataforma, true, availabilityCheck.price);
      } else {
        await this.updateProgress(sessionId, 'error', 'error', 
          `Erro na compra: ${purchaseResult.error}`);
        return { success: false, error: purchaseResult.error };
      }
      
    } else {
      // Compra com IA
      for (let i = 0; i < quantidadeAjustada; i++) {
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
            
            console.log(`🤖 [AI] Gerando domínio ${i + 1}/${quantidadeAjustada}`);
            await this.updateProgress(sessionId, 'generating', 'in_progress', 
              `Gerando domínio ${i + 1}/${quantidadeAjustada}`);
            
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
              
              await this.processPostPurchase(domain, userId, sessionId, trafficSource, plataforma, false, availabilityCheck.price);
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
   * VERIFICAR DISPONIBILIDADE E PREÇO - NAMECHEAP
   */
  async checkDomainAvailability(domain) {
    if (!config.NAMECHEAP_API_KEY || !config.NAMECHEAP_API_USER) {
      console.error('❌ [NAMECHEAP] API não configurada!');
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

      console.log(`🔍 [NAMECHEAP] Verificando disponibilidade de ${domain}...`);
      
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
      console.log(`🔍 [NAMECHEAP DEBUG] XML (primeiros 500 chars):`);
      console.log(checkXml.substring(0, 500));
      
      // Extrair o bloco DomainCheckResult
      const domainResultMatch = checkXml.match(/<DomainCheckResult[^>]*>/i);
      
      if (!domainResultMatch) {
        console.error('❌ [NAMECHEAP] DomainCheckResult não encontrado');
        return { available: false, error: 'Resposta inválida da API' };
      }
      
      const resultBlock = domainResultMatch[0];
      console.log(`🔍 [NAMECHEAP DEBUG] Bloco: ${resultBlock}`);
      
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
          console.log(`💰 [PRICING] Buscando preço para TLD: .${tld}`);
          
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
          
          // DEBUG: Ver resposta completa da API de pricing
          console.log(`💰 [PRICING DEBUG] XML completo:`);
          console.log(pricingXml);
          
          // IMPORTANTE: Buscar especificamente na categoria "register" (não renew, reactivate, etc.)
          // O XML tem várias categorias e precisamos pegar o preço de REGISTRO
          const registerCategoryMatch = pricingXml.match(/<ProductCategory Name="register">([\s\S]*?)<\/ProductCategory>/i);
          
          if (registerCategoryMatch) {
            const registerBlock = registerCategoryMatch[1];
            console.log(`💰 [PRICING DEBUG] Bloco register encontrado`);
            
            // Buscar YourPrice dentro do bloco de register (Duration="1" para 1 ano)
            const yourPriceMatch = registerBlock.match(/Duration="1"[^>]*YourPrice="([0-9.]+)"/);
            if (yourPriceMatch && parseFloat(yourPriceMatch[1]) > 0) {
              price = parseFloat(yourPriceMatch[1]);
              console.log(`✅ [PRICING] YourPrice (register, 1 ano) encontrado: $${price}`);
            } else {
              // Fallback: pegar qualquer YourPrice no bloco register
              const fallbackMatch = registerBlock.match(/YourPrice="([0-9.]+)"/);
              if (fallbackMatch && parseFloat(fallbackMatch[1]) > 0) {
                price = parseFloat(fallbackMatch[1]);
                console.log(`✅ [PRICING] YourPrice (register) encontrado: $${price}`);
              } else {
                // Último fallback: Price normal
                const priceMatch = registerBlock.match(/Price="([0-9.]+)"/);
                if (priceMatch && parseFloat(priceMatch[1]) > 0) {
                  price = parseFloat(priceMatch[1]);
                  console.log(`✅ [PRICING] Price (register) encontrado: $${price}`);
                } else {
                  console.log(`⚠️ [PRICING] Nenhum preço encontrado no bloco register`);
                }
              }
            }
          } else {
            console.log(`⚠️ [PRICING] Categoria 'register' não encontrada no XML`);
            // Fallback antigo (menos preciso)
            const yourPriceMatch = pricingXml.match(/YourPrice="([0-9.]+)"/);
            if (yourPriceMatch && parseFloat(yourPriceMatch[1]) > 0) {
              price = parseFloat(yourPriceMatch[1]);
              console.log(`⚠️ [PRICING] Usando primeiro YourPrice encontrado (fallback): $${price}`);
            }
          }
        } catch (pricingError) {
          console.log(`⚠️ [NAMECHEAP] Erro pricing: ${pricingError.message}`);
          if (pricingError.response) {
            console.log(`⚠️ [NAMECHEAP] Response data: ${JSON.stringify(pricingError.response.data)}`);
          }
        }
      }

      console.log(`📊 [NAMECHEAP] ${domain}`);
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
      console.error('❌ [NAMECHEAP] Erro:', error.message);
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
        
        AddFreeWhoisguard: 'yes',
        WGEnabled: 'yes',
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
   * CONFIGURAR WHOISGUARD AUTO-RENEW (1 ANO)
   */
  async configureWhoisGuard(domain) {
    try {
      console.log(`🔒 [WHOISGUARD] Configurando WhoisGuard para ${domain}...`);
      
      // Passo 1: Buscar WhoisGuard ID associado ao domínio
      const listParams = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.whoisguard.getList',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        PageSize: 100
      };
      
      const listResponse = await axios.get(this.namecheapAPI, { params: listParams, timeout: 30000 });
      const listXml = listResponse.data;
      
      // Buscar o WhoisGuard ID que corresponde ao domínio
      let whoisguardId = null;
      
      // Tentar formato: <Whoisguard ID="123456" DomainName="exemplo.online" ...>
      const regex = new RegExp(`<Whoisguard[^>]*ID="(\\d+)"[^>]*DomainName="${domain.replace('.', '\\.')}"`, 'i');
      const match = listXml.match(regex);
      
      if (match) {
        whoisguardId = match[1];
      } else {
        // Tentar formato inverso (DomainName antes de ID)
        const regexAlt = new RegExp(`<Whoisguard[^>]*DomainName="${domain.replace('.', '\\.')}"[^>]*ID="(\\d+)"`, 'i');
        const matchAlt = listXml.match(regexAlt);
        if (matchAlt) {
          whoisguardId = matchAlt[1];
        }
      }
      
      // Método alternativo: buscar qualquer WhoisGuard que contenha o domínio
      if (!whoisguardId) {
        const allMatches = listXml.match(/<Whoisguard[^>]+>/gi);
        if (allMatches) {
          for (const wgMatch of allMatches) {
            if (wgMatch.toLowerCase().includes(domain.toLowerCase())) {
              const idMatch = wgMatch.match(/ID="(\d+)"/i);
              if (idMatch) {
                whoisguardId = idMatch[1];
                break;
              }
            }
          }
        }
      }
      
      if (!whoisguardId) {
        console.log(`⚠️ [WHOISGUARD] ID não encontrado para ${domain}`);
        console.log(`   XML Response (primeiros 1000 chars): ${listXml.substring(0, 1000)}`);
        return false;
      }
      
      console.log(`✅ [WHOISGUARD] ID encontrado: ${whoisguardId}`);
      
      // Passo 2: Ativar auto-renew (duração padrão: 1 ano)
      console.log(`🔄 [WHOISGUARD] Ativando renovação automática...`);
      const autoRenewParams = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.whoisguard.autorenew',
        ClientIp: config.NAMECHEAP_CLIENT_IP,
        WhoisguardID: whoisguardId,
        Autorenew: 'true'
      };
      
      const autoRenewResponse = await axios.get(this.namecheapAPI, { params: autoRenewParams, timeout: 30000 });
      const autoRenewXml = autoRenewResponse.data;
      
      if (autoRenewXml.includes('Status="OK"')) {
        console.log(`✅ [WHOISGUARD] Auto-renew ativado com sucesso!`);
      } else {
        console.log(`⚠️ [WHOISGUARD] Erro ao ativar auto-renew:`);
        console.log(`   XML: ${autoRenewXml.substring(0, 500)}`);
      }
      
      console.log(`🎉 [WHOISGUARD] Configuração completa!`);
      console.log(`   - Duração: 1 ano`);
      console.log(`   - Auto-renew: Ativado`);
      
      return true;
      
    } catch (error) {
      console.error(`❌ [WHOISGUARD] Erro ao configurar:`, error.message);
      return false;
    }
  }

  /**
   * PROCESSAR PÓS-COMPRA
   * 🔥 CLOUDFLARE + SUPABASE + WORDPRESS + WHATSAPP
   */
  async processPostPurchase(domain, userId, sessionId, trafficSource = null, plataforma = null, isManual = false, purchasePrice = null) {
    try {
      console.log(`🔧 [POST-PURCHASE] Iniciando configurações para ${domain}`);
      if (trafficSource) {
        console.log(`   Fonte de Tráfego: ${trafficSource}`);
      }
      if (plataforma) {
        console.log(`   Plataforma: ${plataforma}`);
      }
      if (purchasePrice) {
        console.log(`   💰 Preço de compra: $${purchasePrice}`);
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
        
        console.log(`✅ [CLOUDFLARE] Configuração concluída`);
      }
      
      // ========================
      // ETAPA 3: WHOISGUARD (1 ano + auto-renew)
      // ========================
      if (!isCancelled) {
        console.log(`🔒 [WHOISGUARD] Configurando proteção de privacidade...`);
        await this.updateProgress(sessionId, 'whoisguard', 'in_progress', 
          `Configurando WhoisGuard para ${domain}...`, domain);
        await this.delay(5000); // Aguardar propagação do WhoisGuard na Namecheap
        const whoisResult = await this.configureWhoisGuard(domain);
        if (whoisResult) {
          await this.updateProgress(sessionId, 'whoisguard', 'completed', 
            `WhoisGuard configurado: 1 ano + auto-renew`, domain);
        }
      }
      
      // ========================
      // ETAPA 4: SUPABASE (SEMPRE EXECUTA - mesmo se cancelado)
      // O domínio foi comprado, precisa estar no banco!
      // ========================
      console.log(`💾 [SUPABASE] Salvando domínio no banco de dados...`);
      await this.updateProgress(sessionId, 'supabase', 'in_progress', 
        `Salvando informações de ${domain}...`, domain);
      
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource, plataforma, purchasePrice);
      
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
      // ETAPA 6: WORDPRESS (WHM + Softaculous + Plugins)
      // ========================
      // Verificar cancelamento antes do WordPress
      if (!isCancelled && await this.isSessionCancelled(sessionId)) {
        console.log(`🛑 [CANCEL] Processo cancelado antes do WordPress`);
        isCancelled = true;
      }
      
      if (!isCancelled) {
        console.log(`🌐 [WORDPRESS] Iniciando instalação do WordPress...`);
        
        try {
          // Passar sessionId para que o wordpress-install emita updates de progresso
          const wpResult = await setupWordPress(domain, sessionId);
          
          if (wpResult.success) {
            console.log(`✅ [WORDPRESS] Instalação concluída com sucesso`);
          } else {
            console.log(`❌ [WORDPRESS] Falha na instalação`);
          }
        } catch (wpError) {
          console.error(`❌ [WORDPRESS] Erro:`, wpError.message);
          await this.updateProgress(sessionId, 'wordpress_install', 'error', 
            `Erro ao instalar WordPress: ${wpError.message}`, domain);
        }
      }
      
      // ========================
      // ETAPA 7: WHATSAPP
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
      
     // ETAPA 4: Criar registro CNAME (raiz)
console.log(`📍 [CLOUDFLARE] Criando DNS CNAME...`);
try {
  await axios.post(
    `${this.cloudflareAPI}/zones/${zoneId}/dns_records`,
    {
      type: 'CNAME',
      name: '@',
      content: 'servidor.institutoexperience.com.br',
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
   * SALVAR NO SUPABASE
   */
  async saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource = null, plataforma = null, purchasePrice = null) {
    try {
      console.log(`💾 [SUPABASE] Buscando informações completas antes de salvar...`);
      if (purchasePrice) {
        console.log(`   💰 Preço de compra: $${purchasePrice}`);
      }
      
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
          if (purchasePrice !== null && purchasePrice !== undefined) {
            console.log(`✅ [SUPABASE] Preço de compra salvo: $${purchasePrice}`);
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
