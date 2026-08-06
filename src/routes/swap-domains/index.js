/**
 * ROTAS DE SWAP DE DOMÍNIO
 * ----------------------------------------------------------------------------
 * O swap acontece em DUAS FASES:
 *
 *   FASE 1 — COMPRA  (POST /manual  ou  POST /)
 *     Compra o domínio novo com EXATAMENTE o mesmo fluxo da compra normal
 *     (Namecheap → Cloudflare completo → nameservers → WhoisGuard → Supabase →
 *     log de compra), MENOS a criação de conta no WHM e a instalação do
 *     WordPress. Termina no step `awaiting_old_domain`.
 *
 *   FASE 2 — TROCA  (POST /execute)
 *     Recebe qual domínio do WHM será substituído e executa modifyacct +
 *     reapontamento do WordPress (banco, páginas, mídias, Elementor) + cache +
 *     SSL + logs + desativação do domínio antigo. Termina em `completed`.
 *
 * Nenhuma rota de compra existente (/api/purchase-domains) é tocada.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/env');

const SwapDomainPurchase = require('../../purchase-domains/swap');
const { listWHMAccounts, findAccountByDomain } = require('../../purchase-domains/swap/whm-swap');
const { runSwapPhase2, updateProgress } = require('../../purchase-domains/swap/swap-runner');
const WordPressDomainPurchase = require('../../purchase-domains/wordpress');
const AtomiCatForBalance = require('../../purchase-domains/atomicat');

// Sessões de swap em andamento
const processingSessions = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/swap-domains/whm-domains
// Lista os domínios que existem hoje no WHM (usado no 2º popup).
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
// POST /api/swap-domains/check-domain
// Body: { domain }
// Disponibilidade + preço do domínio novo (usado no popup manual do swap).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/check-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ success: false, error: 'Domínio é obrigatório' });

    const checker = new WordPressDomainPurchase();
    const availability = await checker.checkDomainAvailability(domain);

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
    console.error('❌ [SWAP][check-domain] erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 1 — POST /api/swap-domains/manual
// Body: { domain (novo), userId, trafficSource }
// NÃO recebe oldDomain: a escolha do domínio antigo é feita depois da compra.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/manual', async (req, res) => {
  let sessionId = null;
  try {
    const { domain, userId, trafficSource } = req.body;
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    if (!domain) return res.status(400).json({ success: false, error: 'Domínio novo é obrigatório' });
    if (!trafficSource || !trafficSource.trim()) {
      return res.status(400).json({ success: false, error: 'Fonte de tráfego é obrigatória' });
    }
    if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
      return res.status(400).json({ success: false, error: 'Formato de domínio inválido' });
    }

    // Disponibilidade + preço do domínio novo
    const checker = new WordPressDomainPurchase();
    const availability = await checker.checkDomainAvailability(domain);
    if (!availability.available) {
      return res.status(400).json({ success: false, error: `Domínio ${domain} não está disponível para registro` });
    }
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
    processingSessions.set(sessionId, { startTime: Date.now(), userId: finalUserId, phase: 1 });

    console.log(`\n🔁 [SWAP][FASE-1][MANUAL] ${domain} | user ${finalUserId} | session ${sessionId}`);

    // Responder imediatamente (o progresso vai pelo Realtime)
    res.json({ success: true, message: 'Compra do domínio novo iniciada', sessionId, domain, balance: currentBalance });

    // Processar em background
    (async () => {
      try {
        const swap = new SwapDomainPurchase();
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
        console.error('❌ [SWAP][FASE-1][ASYNC] erro:', err.message);
        await updateProgress(sessionId, 'error', 'error', err.message || 'Erro na compra do domínio novo');
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
// FASE 1 — POST /api/swap-domains  (compra com IA)
// Body: { nicho, idioma, userId, trafficSource }
// Sempre 1 domínio (swap é 1:1).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  let sessionId = null;
  try {
    const { nicho, idioma = 'portuguese', userId, trafficSource } = req.body;
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    if (!nicho || !nicho.trim()) return res.status(400).json({ success: false, error: 'Nicho é obrigatório' });
    if (!trafficSource || !trafficSource.trim()) {
      return res.status(400).json({ success: false, error: 'Fonte de tráfego é obrigatória' });
    }

    // Saldo (mesma checagem da compra com IA normal — 1 domínio)
    const currentBalance = await new AtomiCatForBalance().checkBalance();
    if (currentBalance < 1.00) {
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente na Namecheap. Disponível: $${currentBalance.toFixed(2)}. Adicione saldo para continuar.`,
        balance: currentBalance
      });
    }

    sessionId = uuidv4();
    processingSessions.set(sessionId, { startTime: Date.now(), userId: finalUserId, phase: 1 });

    console.log(`\n🔁 [SWAP][FASE-1][IA] nicho "${nicho}" | user ${finalUserId} | session ${sessionId}`);

    res.json({ success: true, message: 'Compra do domínio novo iniciada', sessionId, balance: currentBalance });

    (async () => {
      try {
        const swap = new SwapDomainPurchase();
        await swap.purchaseDomain({
          quantidade: 1,
          idioma,
          nicho: nicho.trim(),
          sessionId,
          domainManual: null,
          userId: finalUserId,
          trafficSource: trafficSource.trim(),
          plataforma: 'wordpress',
          isManual: false // com IA = com limite de preço
        });
      } catch (err) {
        console.error('❌ [SWAP][FASE-1][ASYNC] erro:', err.message);
        await updateProgress(sessionId, 'error', 'error', err.message || 'Erro na compra do domínio novo');
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
// FASE 2 — POST /api/swap-domains/execute
// Body: { sessionId, newDomain, oldDomain, userId, userName }
// Executa a troca da conta do WHM + WordPress + SSL + logs + desativação.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/execute', async (req, res) => {
  try {
    const { sessionId, newDomain, oldDomain, userId, userName } = req.body;
    const finalUserId = userId || req.headers['x-user-id'] || config.SUPABASE_USER_ID;

    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId é obrigatório' });
    if (!newDomain) return res.status(400).json({ success: false, error: 'Domínio novo é obrigatório' });
    if (!oldDomain) return res.status(400).json({ success: false, error: 'Selecione o domínio que será substituído' });

    const old = String(oldDomain).trim().toLowerCase();
    const nue = String(newDomain).trim().toLowerCase();

    if (old === nue) {
      return res.status(400).json({ success: false, error: 'O domínio novo precisa ser diferente do antigo' });
    }

    // O domínio antigo precisa existir (e estar ativo) no WHM
    const accounts = await listWHMAccounts();
    const account = accounts.find(a => a.domain === old) || null;
    if (!account) {
      return res.status(400).json({ success: false, error: `Domínio ${old} não encontrado no WHM` });
    }
    if (account.suspended) {
      return res.status(400).json({ success: false, error: `A conta de ${old} está suspensa` });
    }

    const newAlready = accounts.find(a => a.domain === nue);
    if (newAlready) {
      return res.status(400).json({
        success: false,
        error: `O domínio ${nue} já é o principal da conta "${newAlready.user}" no WHM`
      });
    }

    processingSessions.set(sessionId, { startTime: Date.now(), userId: finalUserId, phase: 2 });

    console.log(`\n🔁 [SWAP][FASE-2] iniciada: ${old} → ${nue} | session ${sessionId}`);

    // Responder imediatamente (o progresso vai pelo Realtime)
    res.json({ success: true, message: 'Swap iniciado', sessionId, oldDomain: old, newDomain: nue });

    // Processar em background
    (async () => {
      try {
        await runSwapPhase2({
          sessionId,
          oldDomain: old,
          newDomain: nue,
          userId: finalUserId,
          userName: userName || null
        });
      } catch (err) {
        console.error('❌ [SWAP][FASE-2][ASYNC] erro:', err.message);
        await updateProgress(sessionId, 'error', 'error', err.message || 'Erro no swap', nue);
      } finally {
        processingSessions.delete(sessionId);
      }
    })();

  } catch (error) {
    console.error('❌ [SWAP][execute] erro:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/swap-domains/cancel
// Só tem efeito durante a FASE 1 (compra). Depois que o domínio foi comprado
// o processo não é revertido.
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
