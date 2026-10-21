// =====================================================
// SONDA DO CLOUDFLARE REGISTRAR
//
// SÓ CONSULTA. Nenhuma rota aqui registra domínio, gasta dinheiro ou grava
// no banco. Existe para decidir, com número na mão, se a compra de `.com`
// pela Cloudflare é viável — antes de escrever o fluxo de compra.
//
// GET nas duas porque são leitura pura e repetir não muda nada. A rota de
// coleta de preços é POST justamente por gravar; a diferença é essa.
//
// Passam pelo authMiddleware, como todas as /api — ver server.js.
// =====================================================

const express = require('express');
const router = express.Router();

/**
 * O token alcança a conta nova?
 *
 *   GET /api/registrar/conta
 *
 * Primeira coisa a rodar: se isto falhar, o resto falha pelo mesmo motivo e
 * não adianta investigar preço.
 */
router.get('/conta', async (req, res) => {
  try {
    const r = await require('../../services/cloudflare/registrar').conferirConta();
    res.json(r);
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

/**
 * Um domínio é registrável por API, e por quanto?
 *
 *   GET /api/registrar/sonda?dominio=exemplo-qualquer-123.com
 *
 * Use um nome INVENTADO e improvável. A pergunta não é sobre aquele nome
 * específico: é sobre a TERMINAÇÃO. Um nome já tomado responde
 * `disponivel: false` e não diz nada sobre `.com` ser vendável por API.
 *
 * O campo que decide é `registravelPorApi`. `extension_not_supported_via_api`
 * significa que a Cloudflare vende aquela terminação no painel mas não pela
 * API — e aí a compra automática de `.com` não é possível do jeito pedido.
 */
router.get('/sonda', async (req, res) => {
  const { dominio } = req.query;
  if (!dominio) {
    return res.status(400).json({
      ok: false,
      erro: 'Informe ?dominio=algum-nome-inventado-123.com',
    });
  }

  try {
    const r = await require('../../services/cloudflare/registrar').sondar(dominio);
    res.json(r);
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

module.exports = router;
