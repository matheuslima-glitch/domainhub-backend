/**
 * CONFERÊNCIA DE PRESENÇA: O DOMÍNIO ESTÁ NA CLOUDFLARE? E NO WHM?
 *
 * Grava em `domains.na_cloudflare`, `domains.no_whm` e
 * `domains.presenca_conferida_em`. Quem lê é a aba "Sem acesso" do painel,
 * que desde 30/10/2026 só lista domínio presente nos dois lugares.
 *
 * As fontes são as mesmas que o resto do backend já usa, sem caminho novo:
 *
 *   Cloudflare  `listarZonas()` do coletor diário — todas as zonas da conta
 *   WHM         `listWHMAccounts()` da troca de domínio — o `listaccts`
 *   domínios    `listarDominios()` do coletor — paginado, a base inteira
 *
 * A regra de cruzamento mora em `cruzar.js`, testável sem rede.
 *
 * Roda 1x por dia pelo cron das 05:00 UTC e sob demanda em
 * `POST /api/domains/presenca`.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const cloudflareAnalytics = require('../cloudflare/analytics');
const { listWHMAccounts } = require('../../purchase-domains/swap/whm-swap');
const { motivoParaRecusar, cruzar, fatiar } = require('./cruzar');

// ~36 KB de URL por `update`: 200 UUIDs de 36 caracteres, mais vírgulas.
// Folgado contra o limite do PostgREST.
const IDS_POR_GRAVACAO = 200;

const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

/**
 * Confere e grava. Lança — sem gravar nada — se alguma das fontes falhar.
 *
 * As três listas são baixadas ANTES de qualquer escrita. Uma rodada pela
 * metade, com a Cloudflare gravada e o WHM não, deixaria as duas colunas de
 * uma mesma linha vindo de conferências diferentes.
 */
async function conferir() {
  const inicio = Date.now();

  if (!cloudflareAnalytics.configurado) {
    throw new Error('Cloudflare não configurado (CLOUDFLARE_EMAIL / CLOUDFLARE_API_KEY)');
  }
  if (!config.WHM_URL || !config.WHM_USERNAME || !config.WHM_API_TOKEN) {
    throw new Error('WHM não configurado (WHM_URL / WHM_USERNAME / WHM_API_TOKEN)');
  }

  const [zonas, contas, dominios] = await Promise.all([
    cloudflareAnalytics.listarZonas(),
    listWHMAccounts(),
    cloudflareAnalytics.listarDominios()
  ]);

  console.log(
    `🔎 [PRESENÇA] ${zonas.size} zonas na Cloudflare · ${contas.length} contas no WHM · ` +
      `${dominios.length} domínios na base`
  );

  const recusa = motivoParaRecusar(zonas.size, contas.length);
  if (recusa) throw new Error(recusa);

  const { grupos, contagem } = cruzar(
    dominios,
    zonas.keys(),
    contas.map((c) => c.domain)
  );

  const agora = new Date().toISOString();
  let gravados = 0;
  let falhas = 0;

  for (const g of grupos) {
    for (const ids of fatiar(g.ids, IDS_POR_GRAVACAO)) {
      const { error } = await client
        .from('domains')
        .update({ na_cloudflare: g.na_cloudflare, no_whm: g.no_whm, presenca_conferida_em: agora })
        .in('id', ids);

      if (error) {
        falhas += ids.length;
        console.error(`❌ [PRESENÇA] Falha ao gravar ${ids.length} domínios: ${error.message}`);
      } else {
        gravados += ids.length;
      }
    }
  }

  const segundos = Math.round((Date.now() - inicio) / 1000);
  console.log(
    `✅ [PRESENÇA] ${gravados} domínios conferidos em ${segundos}s — ` +
      `${contagem.nosDois} nos dois · ${contagem.soCloudflare} só na Cloudflare · ` +
      `${contagem.soWhm} só no WHM · ${contagem.emNenhum} em nenhum` +
      (falhas ? ` · ${falhas} falharam ao gravar` : '')
  );

  return {
    sucesso: falhas === 0,
    zonas: zonas.size,
    contasWhm: contas.length,
    ...contagem,
    gravados,
    falhas,
    segundos
  };
}

module.exports = { conferir };
