/**
 * PEDIDOS DE EXCLUSÃO EM LOTE
 *
 * O painel poderia chamar `solicitar_exclusao_lote()` direto por RPC — a
 * função está liberada para `authenticated`. Passa por aqui por um motivo:
 * o aviso no Discord. Se o painel criasse o pedido sozinho e depois pedisse o
 * aviso numa segunda chamada, bastaria a segunda falhar para um pedido ficar
 * esperando sem ninguém saber.
 *
 * Aqui os dois acontecem no mesmo lugar: cria e avisa.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const trava = require('../../services/exclusao');

const router = express.Router();

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * POST /api/exclusao-lote
 *
 * Body: { dominios: [{ id, nome }], motivo?, origem? }
 *
 * O solicitante vem de `req.user.id`, preenchido pelo middleware que valida o
 * JWT — não do corpo da requisição. Quem pediu não pode aprovar o próprio
 * pedido, então esse id é a peça que a trava inteira apoia; aceitá-lo do
 * cliente seria entregar a chave.
 */
router.post('/', async (req, res) => {
  try {
    const { dominios, motivo, origem } = req.body;

    if (!Array.isArray(dominios) || dominios.length === 0) {
      return res.status(400).json({ success: false, error: 'Informe ao menos um domínio' });
    }

    const solicitante = req.user && req.user.id;
    if (!solicitante) {
      return res.status(401).json({ success: false, error: 'Usuário não identificado' });
    }

    const { data: loteId, error } = await supabase.rpc('solicitar_exclusao_lote', {
      p_solicitante: solicitante,
      p_dominios: dominios.map((d) => ({ id: d.id, nome: d.nome || d.domain_name || d.id })),
      p_motivo: motivo || null,
      p_origem: origem === 'ritmo' ? 'ritmo' : 'lote',
    });

    if (error) {
      console.error('❌ [EXCLUSAO] Falha ao criar o pedido:', error.message);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log(`🔒 [EXCLUSAO] Pedido ${loteId} criado com ${dominios.length} domínio(s)`);

    // O aviso vai depois do pedido gravado, e a falha dele não derruba a
    // resposta: o pedido existe e aparece na tela de aprovações de qualquer
    // forma. O que se perde é o ping, não o pedido.
    await trava.avisarCanais({
      id: loteId,
      solicitanteNome: (req.user && (req.user.user_metadata || {}).full_name) || (req.user && req.user.email) || 'Usuário',
      dominios: dominios.map((d) => ({ nome: d.nome || d.domain_name || d.id })),
      motivo: motivo || null,
      origem: origem === 'ritmo' ? 'ritmo' : 'lote',
    });

    res.json({ success: true, loteId });
  } catch (error) {
    console.error('❌ [EXCLUSAO] Erro ao criar pedido:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
