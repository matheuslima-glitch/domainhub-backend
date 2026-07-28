/**
 * ROTA DE SWAP DE DOMÍNIO
 * ----------------------------------------------------------------------------
 * Compra um domínio novo (MESMO fluxo Namecheap / Cloudflare / DNS da compra
 * normal) e, em vez de criar conta + WordPress novo, TROCA o domínio de uma
 * conta cPanel já existente no WHM (modifyacct) para o novo — trazendo tudo
 * junto (arquivos, banco, WordPress, mídias).
 *
 * Diferenças em relação à rota de compra normal:
 *   - NÃO faz verificação de limite de contas no WHM (nenhuma conta é criada);
 *   - exige o domínio antigo (oldDomain) e valida que ele existe no WHM;
 *   - usa a classe SwapDomainPurchase no lugar da WordPressDomainPurchase.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/env');
const { createClient } = require('@supabase/supabase-js');

const SwapDomainPurchase = require('../../purchase-domains/swap');
const { listWHMAccounts, findAccountByDomain } = require('../../purchase-domains/swap/whm-swap');
const WordPressDomainPurchase = require('../../purchase-domains/wordpress');
const AtomiCatForBalance = require('../../purchase-domains/atomicat');

const processingSessions = new Map();

function supa() {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
}

async function updateProgress(sessionId, step, status, message, domainName = null) {
  try {
    await supa().from('domain_purchase_progress').upsert({
      session_id: sessionId, step, status, message, domain_name: domainName,
      updated_at: new Date().toISOString()
    }, { onConflict: 'session_id' });
  } catch (e) {
    console.error('[SWAP-PROGRESS] erro:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/swap-domains/whm-domains
// Lista os domínios atualmente no WHM para o usuário escolher qual substituir.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/whm-domains', async (req, res) => {
  try {
    const accounts = await listWHMAccounts();
    const mainUser = String(config.WHM_ACCOUNT_USERNAME || config.WHM_USERNAME || '').toLowerCase();
    const domains = accounts
      .filter(a => a.domain && a.user && a.user.toLowerCase() !== mainUser)
      .sort((a, b) => a.domain.localeCompare(b.domain));
    res.json({ success: true, total: domains.length, domains });
  } catch (error) {
    console.error('❌ [SWAP] Erro ao listar domínios do WHM:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/swap-domains/manual
// Body: { domain (novo), oldDomain, userId, trafficSource }
// ═══════════════════════════════════════════════════════════════════════════
router.post('/manual', async (req, res) => {
  let sessionId = null;
  try {
    const { domain, oldDomain, userId, trafficSource } = req.body;
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    // Validações
    if (!domain) return res.status(400).json({ success: false, error: 'Domínio novo é obrigatório' });
    if (!oldDomain) return res.status(400).json({ success: false, error: 'Selecione o domínio antigo a ser substituído' });
    if (!trafficSource || !trafficSource.trim()) return res.status(400).json({ success: false, error: 'Fonte de tráfego é obrigatória' });
    if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
      return res.status(400).json({ success: false, error: 'Formato de domínio inválido' });
    }

    // Validar que o domínio antigo existe (e não está suspenso) no WHM
    const account = await findAccountByDomain(oldDomain);
    if (!account) return res.status(400).json({ success: false, error: `Domínio antigo ${oldDomain} não encontrado no WHM` });
    if (account.suspended) return res.status(400).json({ success: false, error: `A conta de ${oldDomain} está suspensa` });

    // Disponibilidade + preço do domínio novo
    const checker = new WordPressDomainPurchase();
    const availability = await checker.checkDomainAvailability(domain);
    if (!availability.available) return res.status(400).json({ success: false, error: `Domínio ${domain} não está disponível para registro` });
    const domainPrice = availability.price || 1.00;

    // Saldo (mesma verificação da compra manual normal)
    const currentBalance = await new AtomiCatForBalance().checkBalance();
    const required = domainPrice + 0.50;
    if (currentBalance < required) {
      const missing = (required - currentBalance).toFixed(2);
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente na Namecheap. Disponível: $${currentBalance.toFixed(2)}. Necessário: $${required.toFixed(2)} (domínio: $${domainPrice.toFixed(2)} + margem). Adicione pelo menos $${missing}.`,
        balance: currentBalance, required, domainPrice
      });
    }

    sessionId = uuidv4();
    processingSessions.set(sessionId, { startTime: Date.now(), userId: finalUserId });

    console.log(`\n🔁 [SWAP][MANUAL] ${oldDomain} → ${domain} | user ${finalUserId} | session ${sessionId}`);

    // Responder imediatamente (assíncrono)
    res.json({ success: true, message: 'Swap iniciado', sessionId, domain, oldDomain, balance: currentBalance });

    // Processar em background
    (async () => {
      try {
        const swap = new SwapDomainPurchase(oldDomain);
        await swap.purchaseDomain({
          quantidade: 1,
          idioma: 'portuguese',
          nicho: null,
          sessionId,
          domainManual: domain,
          userId: finalUserId,
          trafficSource: trafficSource.trim(),
          plataforma: 'wordpress',
          isManual: true // compra manual = sem limite de preço
        });
      } catch (err) {
        console.error('❌ [SWAP][ASYNC] erro:', err.message);
        await updateProgress(sessionId, 'error', 'error', err.message || 'Erro no swap');
      } finally {
        processingSessions.delete(sessionId);
      }
    })();

  } catch (error) {
    console.error('❌ [SWAP][manual] erro:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/swap-domains  (compra com IA)
// Body: { nicho, idioma, oldDomain, userId, trafficSource }
// Sempre 1 domínio (swap é 1:1).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  let sessionId = null;
  try {
    const { nicho, idioma = 'portuguese', oldDomain, userId, trafficSource } = req.body;
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    if (!nicho) return res.status(400).json({ success: false, error: 'Nicho é obrigatório' });
    if (!oldDomain) return res.status(400).json({ success: false, error: 'Selecione o domínio antigo a ser substituído' });

    const account = await findAccountByDomain(oldDomain);
    if (!account) return res.status(400).json({ success: false, error: `Domínio antigo ${oldDomain} não encontrado no WHM` });
    if (account.suspended) return res.status(400).json({ success: false, error: `A conta de ${oldDomain} está suspensa` });

    // Saldo (mesma checagem da compra com IA normal — 1 domínio)
    const currentBalance = await new AtomiCatForBalance().checkBalance();
    if (currentBalance < 1.00) {
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente na Namecheap. Disponível: $${currentBalance.toFixed(2)}. Adicione no mínimo $15.00 para continuar.`,
        balance: currentBalance
      });
    }

    sessionId = uuidv4();
    processingSessions.set(sessionId, { startTime: Date.now(), userId: finalUserId });

    console.log(`\n🔁 [SWAP][IA] nicho "${nicho}" → substituindo ${oldDomain} | user ${finalUserId} | session ${sessionId}`);

    res.json({ success: true, message: 'Swap iniciado', sessionId, oldDomain, balance: currentBalance });

    (async () => {
      try {
        const swap = new SwapDomainPurchase(oldDomain);
        await swap.purchaseDomain({
          quantidade: 1,
          idioma,
          nicho,
          sessionId,
          domainManual: null,
          userId: finalUserId,
          trafficSource: trafficSource || null,
          plataforma: 'wordpress',
          isManual: false // com IA = com limite de preço
        });
      } catch (err) {
        console.error('❌ [SWAP][ASYNC] erro:', err.message);
        await updateProgress(sessionId, 'error', 'error', err.message || 'Erro no swap');
      } finally {
        processingSessions.delete(sessionId);
      }
    })();

  } catch (error) {
    console.error('❌ [SWAP][ia] erro:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/swap-domains/cancel
// ═══════════════════════════════════════════════════════════════════════════
router.post('/cancel', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId é obrigatório' });

    // Reusa o cache de cancelamento da classe (mesmo mecanismo da compra normal)
    WordPressDomainPurchase.markAsCancelled(sessionId);
    await updateProgress(sessionId, 'canceled', 'canceled', 'Swap cancelado pelo usuário');

    res.json({ success: true, sessionId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
