/**
 * ROTA PRINCIPAL DE COMPRA DE DOMÍNIOS MANUAL
 * Este arquivo gerencia as requisições de compra e direciona para WordPress ou AtomiCat
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Importar config no topo para garantir disponibilidade
const config = require('../../config/env');

// Importar classes de compra
const WordPressDomainPurchase = require('../../purchase-domains/wordpress');
const AtomiCatDomainPurchase = require('../../purchase-domains/atomicat');

// Cache de sessões em processamento
const processingSessions = new Map();

// Cache de sessões canceladas (para verificação rápida)
const cancelledSessions = new Set();

// ═══════════════════════════════════════════════════════════════
// FUNÇÃO CENTRALIZADA DE VERIFICAÇÃO WHM
// Chamada como PRIMEIRO passo em qualquer compra WordPress
// ═══════════════════════════════════════════════════════════════
async function verificarLimiteWHM(quantidade = 1) {
  console.log(`📊 [WHM] Verificando limite de contas...`);

  const whmChecker = new WordPressDomainPurchase();
  const whmCheck = await whmChecker.checkWHMAccountAvailability();

  // Se não conseguiu nem consultar o WHM = bloqueia por segurança
  if (whmCheck.error) {
    return {
      bloqueado: true,
      motivo: `Não foi possível verificar o WHM. Tente novamente. (${whmCheck.error})`,
      whmLimitReached: true
    };
  }

  // Limite de contas atingido
  if (!whmCheck.hasCapacity) {
    return {
      bloqueado: true,
      motivo: `Limite de contas atingido no WHM (${whmCheck.currentCount}/${whmCheck.maxLimit}). Libere espaço para comprar novos domínios.`,
      whmLimitReached: true,
      currentCount: whmCheck.currentCount,
      maxLimit: whmCheck.maxLimit
    };
  }

  // Espaço disponível menor que a quantidade solicitada
  if (whmCheck.available !== -1 && whmCheck.available < quantidade) {
    return {
      bloqueado: true,
      motivo: `Espaço insuficiente no WHM. Disponível: ${whmCheck.available} conta(s), solicitado: ${quantidade}. Libere espaço ou reduza a quantidade.`,
      whmLimitReached: true,
      available: whmCheck.available,
      requested: quantidade,
      currentCount: whmCheck.currentCount,
      maxLimit: whmCheck.maxLimit
    };
  }

  console.log(`✅ [WHM] Espaço disponível: ${whmCheck.available === -1 ? 'ilimitado' : whmCheck.available} conta(s)`);
  return { bloqueado: false };
}

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
    
    cancelledSessions.add(sessionId);
    
    if (processingSessions.has(sessionId)) {
      const session = processingSessions.get(sessionId);
      session.cancelled = true;
      processingSessions.set(sessionId, session);
    }
    
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
      
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
 */
function isSessionCancelled(sessionId) {
  if (cancelledSessions.has(sessionId)) {
    return true;
  }
  const session = processingSessions.get(sessionId);
  return session?.cancelled === true;
}

router.isSessionCancelled = isSessionCancelled;

/**
 * POST /api/purchase-domains
 * Compra de domínios com IA
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

    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    // Validação de entrada
    if (!nicho && !domainManual) {
      return res.status(400).json({
        success: false,
        error: 'Nicho é obrigatório para geração com IA ou domínio manual deve ser fornecido'
      });
    }

    if (!['wordpress', 'atomicat'].includes(plataforma)) {
      return res.status(400).json({
        success: false,
        error: 'Plataforma deve ser "wordpress" ou "atomicat"'
      });
    }

    // ============================================
    // ✅ 1º - VERIFICAÇÃO WHM (PRIMEIRO DE TUDO)
    // ============================================
    if (plataforma === 'wordpress') {
      const whm = await verificarLimiteWHM(quantidade);
      if (whm.bloqueado) {
        console.log(`🚫 [WHM] Compra bloqueada: ${whm.motivo}`);
        return res.status(400).json({
          success: false,
          error: whm.motivo,
          whmLimitReached: whm.whmLimitReached,
          currentCount: whm.currentCount,
          maxLimit: whm.maxLimit,
          available: whm.available,
          requested: whm.requested
        });
      }
    }

    // ============================================
    // 2º - VERIFICAÇÃO DE SALDO
    // ============================================
    console.log(`💰 [IA] Verificando saldo antes de iniciar compra...`);
    
    const balanceChecker = new AtomiCatDomainPurchase();
    const currentBalance = await balanceChecker.checkBalance();
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

    res.json({
      success: true,
      message: 'Processo de compra iniciado',
      sessionId: sessionId,
      plataforma: plataforma,
      quantidade: domainManual ? 1 : quantidade,
      manual: !!domainManual,
      balance: currentBalance
    });

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
 * Compra manual de domínio
 */
router.post('/manual', async (req, res) => {
  let sessionId = null;
  
  try {
    const { domain, userId, platform = 'wordpress', trafficSource } = req.body;
    
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;
    
    // Validações básicas
    if (!domain) {
      return res.status(400).json({ success: false, error: 'Domínio é obrigatório' });
    }
    
    if (!trafficSource || !trafficSource.trim()) {
      return res.status(400).json({ success: false, error: 'Fonte de tráfego é obrigatória' });
    }
    
    if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
      return res.status(400).json({ success: false, error: 'Formato de domínio inválido' });
    }
    
    if (!['wordpress', 'atomicat'].includes(platform.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Plataforma deve ser "wordpress" ou "atomicat"' });
    }

    // ============================================
    // ✅ 1º - VERIFICAÇÃO WHM (PRIMEIRO DE TUDO)
    // ============================================
    if (platform.toLowerCase() === 'wordpress') {
      const whm = await verificarLimiteWHM(1);
      if (whm.bloqueado) {
        console.log(`🚫 [WHM] Compra manual bloqueada: ${whm.motivo}`);
        return res.status(400).json({
          success: false,
          error: whm.motivo,
          whmLimitReached: whm.whmLimitReached,
          currentCount: whm.currentCount,
          maxLimit: whm.maxLimit
        });
      }
    }

    // ============================================
    // 2º - VERIFICAÇÃO DE DISPONIBILIDADE E PREÇO
    // ============================================
    console.log(`💰 [MANUAL] Verificando disponibilidade e preço do domínio...`);
    
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
    // 3º - VERIFICAÇÃO DE SALDO
    // ============================================
    console.log(`💰 [MANUAL] Verificando saldo antes de iniciar compra...`);
    
    const balanceChecker = new AtomiCatDomainPurchase();
    const currentBalance = await balanceChecker.checkBalance();
    
    console.log(`💰 [MANUAL] Saldo atual: $${currentBalance.toFixed(2)}`);
    
    const requiredBalance = domainPrice + 0.50;
    if (currentBalance < requiredBalance) {
      const missingAmount = (requiredBalance - currentBalance).toFixed(2);
      console.log(`❌ [MANUAL] Saldo insuficiente!`);
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente na Namecheap. Disponível: $${currentBalance.toFixed(2)}. Necessário: $${requiredBalance.toFixed(2)} (domínio: $${domainPrice.toFixed(2)} + margem). Adicione pelo menos $${missingAmount} para continuar.`,
        balance: currentBalance,
        required: requiredBalance,
        domainPrice: domainPrice
      });
    }
    
    console.log(`✅ [MANUAL] Saldo suficiente para prosseguir`);
    
    sessionId = uuidv4();
    processingSessions.set(sessionId, {
      startTime: Date.now(),
      userId: finalUserId,
      platform: platform.toLowerCase(),
      trafficSource: trafficSource.trim(),
      isManual: true
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
    
    processAsyncPurchase({
      sessionId,
      quantidade: 1,
      idioma: 'portuguese',
      plataforma: platform.toLowerCase(),
      nicho: null,
      domainManual: domain,
      userId: finalUserId,
      isManual: true,
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
 */
async function processAsyncPurchase(params) {
  const { sessionId, quantidade, idioma, plataforma, nicho, domainManual, userId, trafficSource, isManual } = params;
  
  try {
    let result;
    
    if (domainManual) {
      console.log(`📝 [MANUAL] Processando compra manual: ${domainManual}`);
      console.log(`   Plataforma: ${plataforma}`);
      console.log(`   Fonte de Tráfego: ${trafficSource || 'N/A'}`);
      
      if (plataforma === 'wordpress') {
        const wordpressPurchase = new WordPressDomainPurchase();
        result = await wordpressPurchase.purchaseDomain({
          quantidade: 1, idioma, nicho: null, sessionId, domainManual,
          userId, trafficSource, plataforma, isManual: true
        });
      } else if (plataforma === 'atomicat') {
        const atomicatPurchase = new AtomiCatDomainPurchase();
        result = await atomicatPurchase.purchaseDomain({
          quantidade: 1, idioma, nicho: null, sessionId, domainManual,
          userId, trafficSource, plataforma, isManual: true
        });
      }
      
    } else if (plataforma === 'wordpress') {
      console.log(`🌐 [WORDPRESS] Processando compra com IA`);
      const wordpressPurchase = new WordPressDomainPurchase();
      result = await wordpressPurchase.purchaseDomain({
        quantidade, idioma, nicho, sessionId, domainManual: null,
        userId, plataforma, trafficSource, isManual: false
      });
      
    } else if (plataforma === 'atomicat') {
      console.log(`🚀 [ATOMICAT] Processando compra com IA`);
      const atomicatPurchase = new AtomiCatDomainPurchase();
      result = await atomicatPurchase.purchaseDomain({
        quantidade, idioma, nicho, sessionId, domainManual: null,
        userId, plataforma, trafficSource, isManual: false
      });
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`✅ COMPRA FINALIZADA - Session: ${sessionId}`);
    console.log(`👤 User ID: ${userId}`);
    console.log(`   - Sucesso: ${result?.success ? 'Sim' : 'Não'}`);
    console.log(`   - Domínios Registrados: ${result?.domainsRegistered?.join(', ') || 'Nenhum'}`);
    console.log(`   - Total Solicitado: ${result?.totalRequested || quantidade}`);
    console.log(`   - Total Registrado: ${result?.totalRegistered || 0}`);
    if (trafficSource) console.log(`   - Fonte de Tráfego: ${trafficSource}`);
    console.log(`${'='.repeat(70)}\n`);
    
    processingSessions.delete(sessionId);
    
  } catch (error) {
    console.error(`❌ [ASYNC] Erro no processamento assíncrono:`, error);
    
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
      
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
    
    processingSessions.delete(sessionId);
  }
}

/**
 * GET /api/purchase-domains/status/:sessionId
 */
router.get('/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionData = processingSessions.get(sessionId);
    const isProcessing = !!sessionData;
    
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
    
    const { data, error } = await supabase
      .from('domain_purchase_progress')
      .select('*')
      .eq('session_id', sessionId)
      .single();
    
    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Sessão não encontrada', sessionId });
    }
    
    res.json({ success: true, sessionId, isProcessing, userId: sessionData?.userId, progress: data });
    
  } catch (error) {
    console.error('❌ [STATUS] Erro ao verificar status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/purchase-domains/balance
 */
router.get('/balance', async (req, res) => {
  try {
    const atomicatPurchase = new AtomiCatDomainPurchase();
    const balance = await atomicatPurchase.checkBalance();
    
    res.json({ success: true, balance, currency: 'USD', sufficient: balance >= 5.00 });
    
  } catch (error) {
    console.error('❌ [BALANCE] Erro ao verificar saldo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/purchase-domains/search
 */
router.post('/search', async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ success: false, error: 'Domínio é obrigatório' });
    }
    
    console.log(`🔍 [SEARCH] Verificando disponibilidade de: ${domain}`);
    
    const wordpressPurchase = new WordPressDomainPurchase();
    const availability = await wordpressPurchase.checkDomainAvailability(domain);
    
    res.json({
      success: true,
      domain,
      available: availability.available,
      price: availability.price,
      message: availability.available 
        ? `Domínio ${domain} está disponível por $${availability.price}`
        : `Domínio ${domain} não está disponível`
    });
    
  } catch (error) {
    console.error('❌ [SEARCH] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
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
}, 3600000);

module.exports = router;
