/**
 * ROTA PRINCIPAL DE COMPRA DE DOMÍNIOS MANUAL
 * Este arquivo gerencia as requisições de compra e direciona para WordPress ou AtomiCat
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Importar classes de compra
const WordPressDomainPurchase = require('../../purchase-domains/wordpress');
const AtomiCatDomainPurchase = require('../../purchase-domains/atomicat');

// Cache de sessões em processamento
const processingSessions = new Map();

// Cache de sessões canceladas (para verificação rápida)
const cancelledSessions = new Set();

/**
 * POST /api/purchase-domains/cancel
 * Endpoint para cancelar uma compra em andamento
 */
router.post('/cancel', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId é obrigatório'
      });
    }
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🛑 CANCELAMENTO SOLICITADO`);
    console.log(`📋 Session ID: ${sessionId}`);
    console.log(`${'='.repeat(70)}\n`);
    
    // Adicionar à lista de cancelados
    cancelledSessions.add(sessionId);
    
    // Atualizar no processingSessions se existir
    if (processingSessions.has(sessionId)) {
      const session = processingSessions.get(sessionId);
      session.cancelled = true;
      processingSessions.set(sessionId, session);
    }
    
    // Atualizar status no Supabase
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(
        process.env.SUPABASE_URL || config.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY || config.SUPABASE_SERVICE_KEY
      );
      
      await supabase
        .from('domain_purchase_progress')
        .update({
          status: 'canceled',
          step: 'canceled',
          message: 'Compra cancelada pelo usuário',
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId);
        
      console.log(`✅ [CANCEL] Status atualizado no Supabase`);
    } catch (dbError) {
      console.error(`⚠️ [CANCEL] Erro ao atualizar Supabase:`, dbError.message);
    }
    
    res.json({
      success: true,
      message: 'Cancelamento solicitado com sucesso',
      sessionId
    });
    
  } catch (error) {
    console.error(`❌ [CANCEL] Erro:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Função para verificar se uma sessão foi cancelada
 * Exportada para uso nas classes de compra
 */
function isSessionCancelled(sessionId) {
  if (cancelledSessions.has(sessionId)) {
    return true;
  }
  const session = processingSessions.get(sessionId);
  return session?.cancelled === true;
}

// Exportar função de verificação para uso externo
router.isSessionCancelled = isSessionCancelled;

/**
 * POST /api/purchase-domains
 * Endpoint principal para compra de domínios com IA
 * 
 * Body esperado:
 * {
 *   "quantidade": 1,
 *   "idioma": "portuguese",
 *   "plataforma": "wordpress" ou "atomicat",
 *   "nicho": "saúde",
 *   "domainManual": null ou "dominio.online" (opcional para compra manual),
 *   "userId": "uuid-do-usuario"
 * }
 */
router.post('/', async (req, res) => {
  let sessionId = null;
  
  try {
    const { 
      quantidade = 1, 
      idioma = 'portuguese', 
      plataforma = 'wordpress', 
      nicho,
      domainManual = null,
      userId = null,
      trafficSource = null
    } = req.body;

    // Se não tiver userId no body, tentar pegar do header
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    // Validação de entrada
    if (!nicho && !domainManual) {
      return res.status(400).json({
        success: false,
        error: 'Nicho é obrigatório para geração com IA ou domínio manual deve ser fornecido'
      });
    }

    // Validar plataforma
    if (!['wordpress', 'atomicat'].includes(plataforma)) {
      return res.status(400).json({
        success: false,
        error: 'Plataforma deve ser "wordpress" ou "atomicat"'
      });
    }

    // ============================================
    // VERIFICAÇÃO DE SALDO ANTES DE INICIAR
    // ============================================
    console.log(`💰 [IA] Verificando saldo antes de iniciar compra...`);
    
    const AtomiCatForBalance = require('../../purchase-domains/atomicat');
    const balanceChecker = new AtomiCatForBalance();
    const currentBalance = await balanceChecker.checkBalance();
    
    // Calcular saldo mínimo necessário (quantidade * $1.00 para margem)
    const minRequired = quantidade * 1.00;
    
    console.log(`💰 [IA] Saldo atual: $${currentBalance.toFixed(2)}`);
    console.log(`💰 [IA] Saldo necessário (${quantidade} domínios): $${minRequired.toFixed(2)}`);
    
    if (currentBalance < minRequired) {
      console.log(`❌ [IA] Saldo insuficiente!`);
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente na Namecheap. Disponível: $${currentBalance.toFixed(2)}. Necessário: $${minRequired.toFixed(2)}. Adicione no mínimo $15.00 para continuar.`,
        balance: currentBalance,
        required: minRequired
      });
    }
    
    console.log(`✅ [IA] Saldo suficiente para prosseguir`);

    // ============================================
    // VERIFICAÇÃO DE LIMITE WHM ANTES DE INICIAR
    // Evita comprar domínios sem espaço no servidor
    // ============================================
    if (plataforma === 'wordpress') {
      console.log(`📊 [WHM] Verificando limite de contas antes de iniciar compra...`);
      
      const WordPressForWHM = require('../../purchase-domains/wordpress');
      const whmChecker = new WordPressForWHM();
      const whmCheck = await whmChecker.checkWHMAccountAvailability();
      
      if (!whmCheck.error && !whmCheck.hasCapacity) {
        const msg = `Limite de contas atingido no WHM (${whmCheck.currentCount}/${whmCheck.maxLimit}). Libere espaço para comprar novos domínios.`;
        console.log(`🚫 [WHM] ${msg}`);
        return res.status(400).json({
          success: false,
          error: msg,
          whmLimitReached: true,
          currentCount: whmCheck.currentCount,
          maxLimit: whmCheck.maxLimit
        });
      }
      
      if (!whmCheck.error && whmCheck.available > 0 && whmCheck.available < quantidade) {
        const msg = `Espaço insuficiente no WHM. Disponível: ${whmCheck.available} conta(s), solicitado: ${quantidade}. Libere espaço ou reduza a quantidade.`;
        console.log(`🚫 [WHM] ${msg}`);
        return res.status(400).json({
          success: false,
          error: msg,
          whmLimitReached: true,
          available: whmCheck.available,
          requested: quantidade,
          currentCount: whmCheck.currentCount,
          maxLimit: whmCheck.maxLimit
        });
      }
      
      console.log(`✅ [WHM] Espaço disponível: ${whmCheck.available === -1 ? 'ilimitado' : whmCheck.available} conta(s)`);
    }

    // Gerar session ID único
    sessionId = uuidv4();
    processingSessions.set(sessionId, {
      startTime: Date.now(),
      userId: finalUserId
    });

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 NOVA COMPRA DE DOMÍNIO INICIADA`);
    console.log(`📋 Session ID: ${sessionId}`);
    console.log(`👤 User ID: ${finalUserId}`);
    console.log(`🎯 Plataforma: ${plataforma.toUpperCase()}`);
    console.log(`📊 Quantidade: ${quantidade}`);
    console.log(`🌐 Idioma: ${idioma}`);
    console.log(`🏷️ Nicho: ${nicho || 'N/A'}`);
    console.log(`✍️ Domínio Manual: ${domainManual || 'N/A'}`);
    console.log(`📡 Fonte de Tráfego: ${trafficSource || 'N/A'}`);
    console.log(`💰 Saldo disponível: $${currentBalance.toFixed(2)}`);
    console.log(`${'='.repeat(70)}\n`);

    // Responder imediatamente ao cliente (requisição assíncrona)
    res.json({
      success: true,
      message: 'Processo de compra iniciado',
      sessionId: sessionId,
      plataforma: plataforma,
      quantidade: domainManual ? 1 : quantidade,
      manual: !!domainManual,
      balance: currentBalance
    });

    // Processar compra de forma assíncrona
    processAsyncPurchase({
      sessionId,
      quantidade,
      idioma,
      plataforma,
      nicho,
      domainManual,
      userId: finalUserId,
      trafficSource
    });

  } catch (error) {
    console.error(`❌ [ROUTE] Erro crítico na rota:`, error);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao processar requisição'
      });
    }
  }
});

/**
 * POST /api/purchase-domains/manual
 * Compra manual de domínio (quando clicar na lupa)
 * Suporta WordPress e AtomiCat
 */
router.post('/manual', async (req, res) => {
  let sessionId = null;
  
  try {
    const { domain, userId, platform = 'wordpress', trafficSource } = req.body;
    
    // Se não tiver userId no body, tentar pegar do header
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;
    
    // Validações
    if (!domain) {
      return res.status(400).json({
        success: false,
        error: 'Domínio é obrigatório'
      });
    }
    
    if (!trafficSource || !trafficSource.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Fonte de tráfego é obrigatória'
      });
    }
    
    // Validar formato do domínio (deve ter pelo menos um ponto)
    if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
      return res.status(400).json({
        success: false,
        error: 'Formato de domínio inválido'
      });
    }
    
    // Validar plataforma
    if (!['wordpress', 'atomicat'].includes(platform.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Plataforma deve ser "wordpress" ou "atomicat"'
      });
    }
    
    // ============================================
    // VERIFICAÇÃO DE DISPONIBILIDADE E PREÇO
    // ============================================
    console.log(`💰 [MANUAL] Verificando disponibilidade e preço do domínio...`);
    
    const WordPressDomainPurchase = require('../../purchase-domains/wordpress');
    const domainChecker = new WordPressDomainPurchase();
    const availabilityCheck = await domainChecker.checkDomainAvailability(domain);
    
    if (!availabilityCheck.available) {
      return res.status(400).json({
        success: false,
        error: `Domínio ${domain} não está disponível para registro`
      });
    }
    
    const domainPrice = availabilityCheck.price || 1.00;
    console.log(`💰 [MANUAL] Preço do domínio: $${domainPrice.toFixed(2)}`);
    
    // ============================================
    // VERIFICAÇÃO DE SALDO ANTES DE INICIAR
    // ============================================
    console.log(`💰 [MANUAL] Verificando saldo antes de iniciar compra...`);
    
    const AtomiCatForBalance = require('../../purchase-domains/atomicat');
    const balanceChecker = new AtomiCatForBalance();
    const currentBalance = await balanceChecker.checkBalance();
    
    console.log(`💰 [MANUAL] Saldo atual: $${currentBalance.toFixed(2)}`);
    
    // Verificar se tem saldo suficiente para o preço do domínio (com margem de $0.50)
    const requiredBalance = domainPrice + 0.50;
    if (currentBalance < requiredBalance) {
      const missingAmount = (requiredBalance - currentBalance).toFixed(2);
      console.log(`❌ [MANUAL] Saldo insuficiente! Necessário: $${requiredBalance.toFixed(2)}, disponível: $${currentBalance.toFixed(2)}`);
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente na Namecheap. Disponível: $${currentBalance.toFixed(2)}. Necessário: $${requiredBalance.toFixed(2)} (domínio: $${domainPrice.toFixed(2)} + margem). Adicione pelo menos $${missingAmount} para continuar.`,
        balance: currentBalance,
        required: requiredBalance,
        domainPrice: domainPrice
      });
    }
    
    console.log(`✅ [MANUAL] Saldo suficiente para prosseguir`);
    
    // ============================================
    // VERIFICAÇÃO DE LIMITE WHM ANTES DE INICIAR
    // Evita comprar domínios sem espaço no servidor
    // ============================================
    if (platform.toLowerCase() === 'wordpress') {
      console.log(`📊 [WHM] Verificando limite de contas antes de iniciar compra manual...`);
      
      const WordPressForWHM = require('../../purchase-domains/wordpress');
      const whmChecker = new WordPressForWHM();
      const whmCheck = await whmChecker.checkWHMAccountAvailability();
      
      if (!whmCheck.error && !whmCheck.hasCapacity) {
        const msg = `Limite de contas atingido no WHM (${whmCheck.currentCount}/${whmCheck.maxLimit}). Libere espaço para comprar novos domínios.`;
        console.log(`🚫 [WHM] ${msg}`);
        return res.status(400).json({
          success: false,
          error: msg,
          whmLimitReached: true,
          currentCount: whmCheck.currentCount,
          maxLimit: whmCheck.maxLimit
        });
      }
      
      console.log(`✅ [WHM] Espaço disponível: ${whmCheck.available === -1 ? 'ilimitado' : whmCheck.available} conta(s)`);
    }
    
    sessionId = uuidv4();
    processingSessions.set(sessionId, {
      startTime: Date.now(),
      userId: finalUserId,
      platform: platform.toLowerCase(),
      trafficSource: trafficSource.trim(),
      isManual: true  // Flag para indicar compra manual (sem limite de preço)
    });
    
    console.log(`\n📝 [MANUAL] Compra manual iniciada`);
    console.log(`   Domínio: ${domain}`);
    console.log(`   Plataforma: ${platform}`);
    console.log(`   Fonte de Tráfego: ${trafficSource}`);
    console.log(`   Session: ${sessionId}`);
    console.log(`   User ID: ${finalUserId}\n`);
    
    res.json({
      success: true,
      message: 'Compra manual iniciada',
      sessionId: sessionId,
      domain: domain,
      platform: platform.toLowerCase(),
      trafficSource: trafficSource.trim(),
      balance: currentBalance
    });
    
    // Processar de forma assíncrona com a plataforma selecionada
    processAsyncPurchase({
      sessionId,
      quantidade: 1,
      idioma: 'portuguese',
      plataforma: platform.toLowerCase(),
      nicho: null,
      domainManual: domain,
      userId: finalUserId,
      isManual: true,  // Flag para remover limite de preço
      trafficSource: trafficSource.trim()
    });
    
  } catch (error) {
    console.error('❌ [MANUAL] Erro:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * PROCESSAR COMPRA DE FORMA ASSÍNCRONA
 * Executa a compra em background após responder ao cliente
 */
async function processAsyncPurchase(params) {
  const { sessionId, quantidade, idioma, plataforma, nicho, domainManual, userId, trafficSource, isManual } = params;
  
  try {
    let result;
    
    // Se tem domínio manual, processar com a plataforma escolhida
    if (domainManual) {
      console.log(`📝 [MANUAL] Processando compra manual: ${domainManual}`);
      console.log(`   Plataforma: ${plataforma}`);
      console.log(`   Fonte de Tráfego: ${trafficSource || 'N/A'}`);
      console.log(`   Sem limite de preço: ${isManual ? 'SIM' : 'NÃO'}`);
      
      if (plataforma === 'wordpress') {
        const wordpressPurchase = new WordPressDomainPurchase();
        result = await wordpressPurchase.purchaseDomain({
          quantidade: 1,
          idioma,
          nicho: null,
          sessionId,
          domainManual,
          userId,
          trafficSource,
          plataforma,
          isManual: true  // Compra manual = sem limite de preço
        });
      } else if (plataforma === 'atomicat') {
        const atomicatPurchase = new AtomiCatDomainPurchase();
        result = await atomicatPurchase.purchaseDomain({
          quantidade: 1,
          idioma,
          nicho: null,
          sessionId,
          domainManual,
          userId,
          trafficSource,
          plataforma,
          isManual: true  // Compra manual = sem limite de preço
        });
      }
      
    } else if (plataforma === 'wordpress') {
      // Compra com IA para WordPress
      console.log(`🌐 [WORDPRESS] Processando compra com IA`);
      console.log(`   Fonte de Tráfego: ${trafficSource || 'N/A'}`);
      
      const wordpressPurchase = new WordPressDomainPurchase();
      result = await wordpressPurchase.purchaseDomain({
        quantidade,
        idioma,
        nicho,
        sessionId,
        domainManual: null,
        userId,
        plataforma,
        trafficSource,
        isManual: false  // Compra com IA = com limite de preço
      });
      
    } else if (plataforma === 'atomicat') {
      // Compra com IA para AtomiCat
      console.log(`🚀 [ATOMICAT] Processando compra com IA`);
      console.log(`   Fonte de Tráfego: ${trafficSource || 'N/A'}`);
      
      const atomicatPurchase = new AtomiCatDomainPurchase();
      result = await atomicatPurchase.purchaseDomain({
        quantidade,
        idioma,
        nicho,
        sessionId,
        domainManual: null,
        userId,
        plataforma,
        trafficSource,
        isManual: false  // Compra com IA = com limite de preço
      });
    }

    // Log do resultado final
    console.log(`\n${'='.repeat(70)}`);
    console.log(`✅ COMPRA FINALIZADA - Session: ${sessionId}`);
    console.log(`👤 User ID: ${userId}`);
    console.log(`📊 Resultado:`);
    console.log(`   - Sucesso: ${result?.success ? 'Sim' : 'Não'}`);
    console.log(`   - Domínios Registrados: ${result?.domainsRegistered?.join(', ') || 'Nenhum'}`);
    console.log(`   - Total Solicitado: ${result?.totalRequested || quantidade}`);
    console.log(`   - Total Registrado: ${result?.totalRegistered || 0}`);
    if (trafficSource) {
      console.log(`   - Fonte de Tráfego: ${trafficSource}`);
    }
    console.log(`${'='.repeat(70)}\n`);
    
    // Remover sessão do cache após conclusão
    processingSessions.delete(sessionId);
    
  } catch (error) {
    console.error(`❌ [ASYNC] Erro no processamento assíncrono:`, error);
    
    // Tentar atualizar status de erro no banco
    try {
      const { createClient } = require('@supabase/supabase-js');
      const config = require('../../config/env');
      
      const supabase = createClient(
        config.SUPABASE_URL,
        config.SUPABASE_SERVICE_KEY
      );
      
      await supabase
        .from('domain_purchase_progress')
        .upsert({
          session_id: sessionId,
          step: 'error',
          status: 'error',
          message: error.message || 'Erro no processamento',
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id' });
        
    } catch (dbError) {
      console.error('❌ Erro ao atualizar status de erro no banco:', dbError);
    }
    
    // Remover sessão do cache
    processingSessions.delete(sessionId);
  }
}

/**
 * GET /api/purchase-domains/status/:sessionId
 * Verificar status de uma compra em andamento
 */
router.get('/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Verificar se a sessão existe no cache
    const sessionData = processingSessions.get(sessionId);
    const isProcessing = !!sessionData;
    
    // Buscar status no banco
    const { createClient } = require('@supabase/supabase-js');
    const config = require('../../config/env');
    
    const supabase = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_KEY
    );
    
    const { data, error } = await supabase
      .from('domain_purchase_progress')
      .select('*')
      .eq('session_id', sessionId)
      .single();
    
    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Sessão não encontrada',
        sessionId
      });
    }
    
    res.json({
      success: true,
      sessionId,
      isProcessing,
      userId: sessionData?.userId,
      progress: data
    });
    
  } catch (error) {
    console.error('❌ [STATUS] Erro ao verificar status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/purchase-domains/balance
 * Verificar saldo da conta Namecheap
 */
router.get('/balance', async (req, res) => {
  try {
    // Usar AtomiCat para verificar saldo (mesma API Namecheap)
    const atomicatPurchase = new AtomiCatDomainPurchase();
    const balance = await atomicatPurchase.checkBalance();
    
    res.json({
      success: true,
      balance: balance,
      currency: 'USD',
      sufficient: balance >= 5.00 // Mínimo recomendado
    });
    
  } catch (error) {
    console.error('❌ [BALANCE] Erro ao verificar saldo:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/purchase-domains/search
 * Endpoint para busca/pesquisa de domínio (quando clicar na lupa)
 * Verifica disponibilidade sem comprar
 */
router.post('/search', async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({
        success: false,
        error: 'Domínio é obrigatório'
      });
    }
    
    console.log(`🔍 [SEARCH] Verificando disponibilidade de: ${domain}`);
    
    // Usar WordPress para verificar disponibilidade
    const wordpressPurchase = new WordPressDomainPurchase();
    const availability = await wordpressPurchase.checkDomainAvailability(domain);
    
    res.json({
      success: true,
      domain: domain,
      available: availability.available,
      price: availability.price,
      message: availability.available 
        ? `Domínio ${domain} está disponível por $${availability.price}`
        : `Domínio ${domain} não está disponível`
    });
    
  } catch (error) {
    console.error('❌ [SEARCH] Erro:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Limpar sessões antigas do cache a cada hora
 */
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  let cleaned = 0;
  
  for (const [sessionId, sessionData] of processingSessions) {
    if (sessionData.startTime < oneHourAgo) {
      processingSessions.delete(sessionId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 [CACHE] ${cleaned} sessões antigas removidas do cache`);
  }
}, 3600000); // 1 hora

// Importar config aqui para ter acesso nas funções
const config = require('../../config/env');


module.exports = router;
