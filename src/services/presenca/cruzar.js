/**
 * O CRUZAMENTO DA PRESENÇA, SEM REDE
 *
 * Recebe as três listas já baixadas — domínios da base, zonas da Cloudflare,
 * contas do WHM — e diz onde cada domínio está. Mora separado de `index.js`
 * para `npm run testa:presenca` exercitar a regra sem credencial: `index.js`
 * arrasta `config/env`, que lança quando falta variável.
 */

/** Nome comparável. `domains` tem nomes em caixa mista; Cloudflare e WHM devolvem minúsculo. */
const chave = (nome) => String(nome || '').trim().toLowerCase();

/**
 * Motivo para NÃO gravar a rodada, ou `null` se as listas parecem sãs.
 *
 * Lista vazia quase nunca é verdade: é token revogado, IP fora da liberação
 * ou resposta de erro que veio com HTTP 200. O `listaccts` do WHM, por
 * exemplo, devolve `data.acct` ausente quando recusa — e `listWHMAccounts`
 * transforma isso em `[]`. Gravar em cima disso marcaria a base inteira como
 * "fora do WHM" e esvaziaria a aba Sem acesso sem nenhum aviso.
 */
function motivoParaRecusar(totalZonas, totalContasWhm) {
  if (!totalZonas) return 'Cloudflare devolveu 0 zonas — credencial ou resposta de erro; nada foi gravado';
  if (!totalContasWhm) return 'WHM devolveu 0 contas — token, IP ou resposta de erro; nada foi gravado';
  return null;
}

/**
 * Agrupa os domínios pelas quatro combinações de presença.
 *
 * Grupos, e não uma linha por domínio, porque cada grupo vira poucos
 * `update ... where id in (...)` em vez de ~2.700 chamadas.
 *
 * @param {Array<{id:string, domain_name:string}>} dominios
 * @param {Iterable<string>} zonas       nome de cada zona da conta Cloudflare
 * @param {Iterable<string>} principais  domínio PRINCIPAL de cada conta do WHM
 */
function cruzar(dominios, zonas, principais) {
  const naCloudflare = new Set([...zonas].map(chave));
  const noWhm = new Set([...principais].map(chave).filter(Boolean));

  const grupos = new Map();
  for (const d of dominios || []) {
    const nome = chave(d.domain_name);
    const cf = naCloudflare.has(nome);
    const whm = noWhm.has(nome);
    const k = `${cf}|${whm}`;
    if (!grupos.has(k)) grupos.set(k, { na_cloudflare: cf, no_whm: whm, ids: [] });
    grupos.get(k).ids.push(d.id);
  }

  const tamanho = (cf, whm) => (grupos.get(`${cf}|${whm}`) || { ids: [] }).ids.length;

  return {
    grupos: [...grupos.values()],
    contagem: {
      dominios: (dominios || []).length,
      nosDois: tamanho(true, true),
      soCloudflare: tamanho(true, false),
      soWhm: tamanho(false, true),
      emNenhum: tamanho(false, false),
    },
  };
}

/** Fatia uma lista em pedaços de `tamanho`. O `in (...)` vai na URL, que tem limite. */
function fatiar(lista, tamanho) {
  const fatias = [];
  for (let i = 0; i < lista.length; i += tamanho) fatias.push(lista.slice(i, i + tamanho));
  return fatias;
}

module.exports = { chave, motivoParaRecusar, cruzar, fatiar };
