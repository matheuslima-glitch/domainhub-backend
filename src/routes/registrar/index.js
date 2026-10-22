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
 * O token alcança a API de Registrar?
 *
 *   GET /api/registrar/conta
 *
 * Primeira coisa a rodar: se isto falhar, o resto falha pelo mesmo motivo e
 * não adianta investigar preço.
 *
 * Bate no `domain-check` com um nome fixo. A primeira versão lia os dados
 * da conta, o que exige uma permissão que um token corretamente mínimo não
 * tem — e aí ela falhava justamente quando o token estava certo.
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
 * O campo que decide é `registravelPorApi`. Quando ele é `false`, `motivo`
 * diz por quê, e os casos levam a conclusões OPOSTAS:
 *
 *   domain_unavailable               o NOME está tomado. Tente outro; não
 *                                    diz nada sobre a terminação.
 *   extension_not_supported_via_api  a terminação existe no painel mas não
 *                                    na API. Mata a compra automática.
 *   domain_premium                   nome premium, que esta API não
 *                                    registra. É sobre o nome, não a
 *                                    terminação.
 *
 * A resposta traz REGISTRO e RENOVAÇÃO na mesma chamada, e compara o
 * registro com o teto de US$ 5,00 que o fluxo de compra aplica.
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
