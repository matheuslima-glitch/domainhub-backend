/**
 * ROTA PRINCIPAL DE COMPRA DE DOMÍNIOS
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
 *   "domainManual": null ou "dominio.online" (opcional para compra manual)
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
      domainManual = null 
    } = req.body;

    // Validação de entrada
    if (!nicho && !domainManual) {
      return res.status(400).json({
        success: false,
        error: 'Nicho é obrigatório para geração com IA'
      });
    }

    // Validar plataforma
    if (!['wordpress', 'atomicat'].includes(plataforma)) {
      return res.status(400).json({
        success: false,
        error: 'Plataforma deve ser "wordpress" ou "atomicat"'
      });
    }

    // Gerar session ID único
    sessionId = uuidv4();
    processingSessions.set(sessionId, Date.now());

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 NOVA COMPRA DE DOMÍNIO INICIADA`);
    console.log(`📋 Session ID: ${sessionId}`);
    console.log(`🎯 Plataforma: ${plataforma.toUpperCase()}`);
    console.log(`📊 Quantidade: ${quantidade}`);
    console.log(`🌐 Idioma: ${idioma}`);
    console.log(`🏷️ Nicho: ${nicho || 'N/A'}`);
    console.log(`✍️ Domínio Manual: ${domainManual || 'N/A'}`);
    console.log(`${'='.repeat(60)}\n`);

    // Responder imediatamente ao cliente (requisição assíncrona)
    res.json({
      success: true,
      message: 'Processo de compra iniciado',
      sessionId: sessionId,
      plataforma: plataforma,
      quantidade: quantidade
    });

    // Processar compra de forma assíncrona
    processAsyncPurchase({
      sessionId,
      quantidade,
      idioma,
      plataforma,
      nicho,
      domainManual
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
 * PROCESSAR COMPRA DE FORMA ASSÍNCRONA
 * Executa a compra em background após responder ao cliente
 */
async function processAsyncPurchase(params) {
  const { sessionId, quantidade, idioma, plataforma, nicho, domainManual } = params;
  
  try {
    let result;
    
    // Se tem domínio manual, comprar direto com WordPress
    if (domainManual) {
      console.log(`📝 [MANUAL] Processando compra manual do domínio: ${domainManual}`);
      
      const wordpressPurchase = new WordPressDomainPurchase();
      result = await wordpressPurchase.purchaseDomain({
        quantidade: 1,
        idioma,
        nicho: domainManual,
        sessionId
      });
      
    } else if (plataforma === 'wordpress') {
      // Compra com IA para WordPress
      console.log(`🌐 [WORDPRESS] Processando compra com IA`);
      
      const wordpressPurchase = new WordPressDomainPurchase();
      result = await wordpressPurchase.purchaseDomain({
        quantidade,
        idioma,
        nicho,
        sessionId
      });
      
    } else if (plataforma === 'atomicat') {
      // Compra com IA para AtomiCat
      console.log(`🚀 [ATOMICAT] Processando compra com IA`);
      
      const atomicatPurchase = new AtomiCatDomainPurchase();
      result = await atomicatPurchase.purchaseDomain({
        quantidade,
        idioma,
        nicho,
        sessionId
      });
    }

    // Log do resultado final
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ COMPRA FINALIZADA - Session: ${sessionId}`);
    console.log(`📊 Resultado:`);
    console.log(`   - Sucesso: ${result?.success ? 'Sim' : 'Não'}`);
    console.log(`   - Domínios Registrados: ${result?.domainsRegistered?.join(', ') || 'Nenhum'}`);
    console.log(`   - Total Solicitado: ${result?.totalRequested || quantidade}`);
    console.log(`   - Total Registrado: ${result?.totalRegistered || 0}`);
    console.log(`${'='.repeat(60)}\n`);
    
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
    const isProcessing = processingSessions.has(sessionId);
    
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
 * POST /api/purchase-domains/manual
 * Compra manual de domínio (sempre WordPress)
 */
router.post('/manual', async (req, res) => {
  let sessionId = null;
  
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({
        success: false,
        error: 'Domínio é obrigatório'
      });
    }
    
    // Validar formato do domínio
    if (!domain.endsWith('.online')) {
      return res.status(400).json({
        success: false,
        error: 'Apenas domínios .online são suportados'
      });
    }
    
    sessionId = uuidv4();
    
    console.log(`\n📝 [MANUAL] Compra manual iniciada`);
    console.log(`   Domínio: ${domain}`);
    console.log(`   Session: ${sessionId}\n`);
    
    res.json({
      success: true,
      message: 'Compra manual iniciada',
      sessionId: sessionId,
      domain: domain
    });
    
    // Processar de forma assíncrona
    processAsyncPurchase({
      sessionId,
      quantidade: 1,
      idioma: 'portuguese',
      plataforma: 'wordpress',
      nicho: null,
      domainManual: domain
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
 * Limpar sessões antigas do cache a cada hora
 */
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  let cleaned = 0;
  
  for (const [sessionId, timestamp] of processingSessions) {
    if (timestamp < oneHourAgo) {
      processingSessions.delete(sessionId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 [CACHE] ${cleaned} sessões antigas removidas do cache`);
  }
}, 3600000); // 1 hora

module.exports = router;
