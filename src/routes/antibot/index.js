// =====================================================
// ANTIBOT EM LOTE
//
//   POST /api/antibot/lote
//   { "dominios": ["a.com", "b.online"], "modo": "simular" }
//
// Coloca (ou tira) a regra de desafio gerenciado da Cloudflare na zona de
// cada domínio da lista. Mudança OpenSpec: openspec/changes/antibot-em-lote.
//
// ── MODOS ────────────────────────────────────────────────────────────────
//
//   simular   PADRÃO. Não altera nada: diz o que a aplicação faria.
//   aplicar   cria a regra (ou reativa a nossa, se estiver desligada).
//   remover   apaga SÓ a regra criada por esta automação. Regra feita à mão
//             no painel nunca é apagada.
//
// ── QUEM PODE ────────────────────────────────────────────────────────────
//
// Só super admin. O JWT sozinho não basta: qualquer usuário do painel tem um,
// e isto muda a segurança de sites no ar. Se o cargo não puder ser conferido,
// barra (503).
//
// ── COMO USAR (Console do navegador, com o painel aberto e logado) ────────
//
//   const t = JSON.parse(localStorage['sb-domainhub-auth']).access_token;
//   const r = await fetch('https://domainhub-backend.onrender.com/api/antibot/lote', {
//     method: 'POST',
//     headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
//     body: JSON.stringify({ dominios: ['dominio1.com', 'dominio2.online'], modo: 'simular' })
//   });
//   console.log(r.status, JSON.stringify(await r.json(), null, 2));
//
// Troque `modo` para 'aplicar' ou 'remover'. Até 50 domínios por pedido.
// `dominios` também aceita um texto com um domínio por linha.
//
// ── RESULTADOS POR DOMÍNIO ───────────────────────────────────────────────
//
//   criada          a regra foi criada (ou seria, na simulação)
//   reativada       a nossa regra existia desligada e foi ligada
//   ja_existia      já tinha a nossa regra ativa, ou uma igual feita à mão
//   limite          a zona já tem 5 regras personalizadas (máximo do plano free)
//   removida        a nossa regra foi apagada
//   nada_a_remover  a zona não tem a nossa regra
//   desconhecido    o domínio não está cadastrado no DomainHub
//   recusado        é a zona principal, que nunca é alterada
//   sem_zona        não existe zona com esse nome na Cloudflare
//   erro            a Cloudflare recusou; veja `erro`. Os outros seguem, e um
//                   resumo vai para o Telegram (fora da simulação)
//
// Todas as rotas /api passam pelo authMiddleware — ver server.js.
// =====================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const regras = require('../../services/cloudflare/antibot-regras');

const router = express.Router();

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Só super admin. Se não der para conferir o cargo, barra. */
async function soSuperAdmin(req, res, next) {
  const { data, error } = await supabase.rpc('e_super_admin', { p_user_id: req.user?.id });
  if (error) {
    return res.status(503).json({ ok: false, erro: `Não deu para conferir o cargo: ${error.message}` });
  }
  if (data !== true) {
    return res.status(403).json({ ok: false, erro: 'Só um super admin pode usar esta rota.' });
  }
  next();
}

/** Os domínios da lista que existem em `domains`. */
async function conhecidosNaBase(dominios) {
  const { data, error } = await supabase
    .from('domains')
    .select('domain_name')
    .in('domain_name', dominios);
  if (error) throw new Error(`Não deu para consultar os domínios: ${error.message}`);
  return new Set((data || []).map((d) => String(d.domain_name || '').trim().toLowerCase()));
}

router.post('/lote', soSuperAdmin, async (req, res) => {
  const pedido = regras.normalizarPedido(req.body || {});
  if (!pedido.ok) return res.status(400).json({ ok: false, erro: pedido.erro });

  const antibot = require('../../services/cloudflare/antibot');
  if (antibot.ocupado()) {
    return res.status(409).json({ ok: false, erro: 'Já há um lote em andamento. Espere ele terminar.' });
  }

  let conhecidos;
  try {
    conhecidos = await conhecidosNaBase(pedido.dominios);
  } catch (e) {
    return res.status(503).json({ ok: false, erro: e.message });
  }

  console.log(`🛡️ [ANTIBOT] Lote "${pedido.modo}" com ${pedido.dominios.length} domínio(s), pedido por ${req.user.id}`);
  const relatorio = await antibot.rodarLote({ modo: pedido.modo, dominios: pedido.dominios, conhecidos });
  if (relatorio.ocupado) {
    return res.status(409).json({ ok: false, erro: 'Já há um lote em andamento. Espere ele terminar.' });
  }

  console.log(`🛡️ [ANTIBOT] Lote "${pedido.modo}" concluído: ${JSON.stringify(relatorio.totais)}`);
  res.json({ ok: true, ...relatorio });
});

module.exports = router;
