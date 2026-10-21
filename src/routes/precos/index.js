// =====================================================
// COLETA DE PREÇOS SOB DEMANDA
//
// Existe por um motivo prático: o cron roda 1x por dia, às 04:40 UTC, e o
// shell do Render é serviço pago. Sem esta rota, quem sobe a migration fica
// com a aba de Custo mostrando "sem preço de renovação" por até 24 horas e
// sem nenhuma forma de saber se o problema é a espera ou uma falha.
//
// É o mesmo caminho do cron — `pricing.sincronizar()` —, então testar aqui
// testa o que vai para produção, e não uma simulação que pode divergir. É o
// mesmo arranjo de `/api/notify/criticos`.
//
// ── POST, E NÃO GET ──────────────────────────────────────────────────────
//
// Ela ESCREVE no banco e gasta uma chamada da Namecheap. GET é a coisa que
// navegador, prefetch e health-check disparam sozinhos.
//
// Passa pelo authMiddleware, como todas as /api — ver server.js.
// =====================================================

const express = require('express');
const router = express.Router();

/**
 * Roda AGORA a coleta de preços, sem esperar o cron das 04:40.
 *
 * O erro vai no corpo da resposta, e não só no log, porque é aqui que as
 * duas causas prováveis se distinguem:
 *
 *   tabela não existe   -> a migration ainda não foi aplicada no Supabase
 *   Namecheap recusou   -> IP fora da whitelist, ou credencial
 *
 * Sem a mensagem, as duas aparecem como a mesma tela vazia.
 */
router.post('/coletar', async (req, res, next) => {
  try {
    const resultado = await require('../../services/namecheap/pricing').sincronizar();
    res.json({ success: true, ...resultado });
  } catch (error) {
    // 502 e não 500: a falha é quase sempre de uma dependência externa (a
    // API da Namecheap) ou de um objeto que falta no banco, não um defeito
    // deste processo.
    res.status(502).json({ success: false, erro: error.message });
  }
});

module.exports = router;
