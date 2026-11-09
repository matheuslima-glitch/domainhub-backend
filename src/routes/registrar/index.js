// =====================================================
// SONDA E REGISTRO DE TESTE DO CLOUDFLARE REGISTRAR
//
// As rotas GET SÓ CONSULTAM: não gastam dinheiro nem gravam no banco. GET
// porque repetir não muda nada.
//
// `POST /registro-teste` GASTA DINHEIRO, SEM REEMBOLSO. Ela e
// `POST /apontar-teste` passam pela trava `soTesteLiberado`.
//
// Todas passam pelo authMiddleware, como as demais /api — ver server.js.
// =====================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

const router = express.Router();

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Libera só com o interruptor ligado no Render e para super admin.
 *
 * O JWT sozinho não basta: qualquer usuário do painel tem um, e aqui se gasta
 * dinheiro. Se não der para conferir o cargo, barra.
 */
async function soTesteLiberado(req, res, next) {
  if (!config.REGISTRO_TESTE_LIGADO) {
    return res.status(403).json({
      ok: false,
      erro: 'Registro de teste desligado. Defina REGISTRO_TESTE_LIGADO=true no Render.',
    });
  }

  const { data, error } = await supabase.rpc('e_super_admin', { p_user_id: req.user?.id });
  if (error) {
    return res.status(503).json({ ok: false, erro: `Não deu para conferir o cargo: ${error.message}` });
  }
  if (data !== true) {
    return res.status(403).json({ ok: false, erro: 'Só um super admin pode usar esta rota.' });
  }

  next();
}

/** Recusa nossa é 400; falha da Cloudflare ou resultado incerto é 502. */
function responder(res, r) {
  res.status(r.ok ? 200 : r.recusado ? 400 : 502).json(r);
}

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

/**
 * REGISTRA UM `.com` NA CONTA NOVA. GASTA DINHEIRO, SEM REEMBOLSO.
 *
 *   POST /api/registrar/registro-teste
 *   { "dominio": "exemplo.com", "confirmar": "exemplo.com" }
 *
 * Se a resposta vier com `incerto: true`, NÃO repita: confira no painel da
 * conta nova se o domínio foi registrado.
 */
router.post('/registro-teste', soTesteLiberado, async (req, res) => {
  try {
    console.log(`💳 [REGISTRAR] Registro de teste pedido por ${req.user.id}`);
    const { dominio, confirmar } = req.body || {};
    responder(res, await require('../../services/cloudflare/registro-teste').registrarUm({ dominio, confirmar }));
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

/**
 * APONTA O DOMÍNIO PARA A CONTA ATUAL. NÃO GASTA DINHEIRO.
 *
 *   POST /api/registrar/apontar-teste
 *   { "dominio": "exemplo.com" }
 *
 * Pode rodar de novo: só cria o que falta e devolve o estado de agora. Quando
 * `pronto` vier `true`, a zona, o Custom Hostname e o certificado estão ativos.
 */
router.post('/apontar-teste', soTesteLiberado, async (req, res) => {
  try {
    responder(res, await require('../../services/cloudflare/registro-teste').apontar(req.body?.dominio));
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

module.exports = router;
