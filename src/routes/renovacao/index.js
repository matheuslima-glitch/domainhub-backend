// =====================================================
// RENOVAÇÃO ESCOLHIDA
//
// A única rota do sistema que GASTA DINHEIRO a pedido de um clique.
//
// Renovação é cobrada na hora, do saldo da Namecheap, e não é
// reembolsável. Tudo aqui é desenhado para que um engano custe um erro na
// tela, e não uma cobrança.
//
// Passa pelo authMiddleware, como todas as /api — e aqui isso importa em
// dobro: `req.user.id` vai para `solicitado_por`, então toda renovação
// fica com dono.
// =====================================================

const express = require('express');
const router = express.Router();

/**
 * Renova os domínios marcados na tela.
 *
 *   POST /api/renovacao
 *   { "dominios": ["exemplo.site", "outro.com"] }
 *
 * POST, e não poderia ser outra coisa: escreve, cobra, e repetir NÃO é
 * inofensivo — por isso a trava de 30 minutos no serviço.
 *
 * ── RESPONDE 207 QUANDO O LOTE É PARCIAL ─────────────────────────────────
 *
 * Um lote pode ter sucesso em uns e falha em outros — saldo que acaba no
 * meio é o caso provável. A tela precisa distinguir "renovou tudo" de
 * "renovou metade", e um 200 liso esconderia isso.
 *
 * Cada item volta com o próprio resultado, incluindo `cobradoUsd` e
 * `orderId`, que são o que permite conferir contra a fatura.
 */
router.post('/', async (req, res) => {
  const { dominios } = req.body || {};

  if (!Array.isArray(dominios) || !dominios.length) {
    return res.status(400).json({
      success: false,
      erro: 'Informe { "dominios": ["exemplo.com"] }',
    });
  }

  try {
    const r = await require('../../services/namecheap/renovacao').renovarLote(
      dominios,
      req.user?.id,
    );

    // 207 = alguns deram certo, outros não.
    const parcial = r.renovados > 0 && r.renovados < r.total;
    const nenhum = r.renovados === 0;

    res.status(nenhum ? 502 : parcial ? 207 : 200).json({ success: !nenhum, ...r });
  } catch (error) {
    // Falha ANTES de qualquer cobrança: lista vazia, lote grande demais, ou
    // banco fora. Nada foi gasto.
    res.status(400).json({ success: false, erro: error.message });
  }
});

module.exports = router;
