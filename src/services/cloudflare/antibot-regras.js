/**
 * ANTIBOT EM LOTE — LÓGICA PURA
 *
 * Sem rede e sem `config/env`: só decide. Quem chama a Cloudflare é
 * `antibot.js`. Separado assim para as provas cobrirem todas as decisões sem
 * precisar de credencial (`npm run testa:antibot`).
 *
 * Mudança OpenSpec: openspec/changes/antibot-em-lote.
 *
 * ── A REGRA ──────────────────────────────────────────────────────────────
 *
 * Desafio gerenciado para QUALQUER host da zona do domínio. É a mesma regra
 * que, criada à mão em sugarresethub.com em 13/11/2026, fez o site passar a
 * responder 403 com `cf-mitigated: challenge`. A regra `filtro` da zona
 * principal tem a mesma expressão, mas não alcança os domínios comprados.
 *
 * Se o piloto pedir exceções (robôs verificados, IP do Checkmate), a mudança
 * é na constante EXPRESSAO, e só nela.
 *
 * ── COMO A REGRA É RECONHECIDA ───────────────────────────────────────────
 *
 *   ref "domainhub-antibot"   a nossa. É a única que a remoção apaga.
 *   mesma ação + expressão    equivalente feita à mão (ex.: "Antibot-teste").
 *                             Conta como existente, para não duplicar, mas
 *                             nunca é apagada pela automação.
 *
 * A descrição não serve para isso: qualquer pessoa edita no painel.
 */

const LIMITE_LOTE = 50;
const LIMITE_REGRAS_ZONA = 5; // plano free; as desativadas também contam
const MODOS = ['simular', 'aplicar', 'remover'];
const MODO_PADRAO = 'simular';

const FASE = 'http_request_firewall_custom';
const REF = 'domainhub-antibot';
const DESCRICAO = 'Antibot (DomainHub)';
const EXPRESSAO = '(http.host wildcard r"*")';
const ACAO = 'managed_challenge';

const FORMATO_DOMINIO = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Valida o corpo do pedido e devolve a lista pronta.
 *
 * `dominios` pode vir como lista ou como texto (uma linha por domínio, ou
 * separado por vírgula/espaço), porque o uso real é colar uma lista no
 * Console. Nomes são normalizados (sem espaço, minúsculo) e repetidos saem.
 *
 * @returns {{ ok: true, modo: string, dominios: string[] } | { ok: false, erro: string }}
 */
function normalizarPedido(corpo) {
  const modo = corpo?.modo === undefined || corpo?.modo === null || corpo?.modo === ''
    ? MODO_PADRAO
    : String(corpo.modo).trim().toLowerCase();
  if (!MODOS.includes(modo)) {
    return { ok: false, erro: `Modo desconhecido: "${corpo.modo}". Use ${MODOS.join(', ')}.` };
  }

  const bruto = corpo?.dominios;
  const itens = Array.isArray(bruto)
    ? bruto
    : typeof bruto === 'string' ? bruto.split(/[\s,;]+/) : [];

  const vistos = new Set();
  const dominios = [];
  const invalidos = [];
  for (const item of itens) {
    const nome = String(item ?? '').trim().toLowerCase();
    if (!nome) continue;
    if (!FORMATO_DOMINIO.test(nome)) { invalidos.push(String(item).trim()); continue; }
    if (vistos.has(nome)) continue;
    vistos.add(nome);
    dominios.push(nome);
  }

  if (invalidos.length) {
    return { ok: false, erro: `Nomes inválidos: ${invalidos.join(', ')}` };
  }
  if (dominios.length === 0) {
    return { ok: false, erro: 'Informe ao menos um domínio em "dominios".' };
  }
  if (dominios.length > LIMITE_LOTE) {
    return { ok: false, erro: `No máximo ${LIMITE_LOTE} domínios por pedido (vieram ${dominios.length}).` };
  }
  return { ok: true, modo, dominios };
}

/** Expressão sem diferença de espaços — o painel às vezes reformata. */
function mesmaExpressao(expressao) {
  return String(expressao || '').replace(/\s+/g, ' ').trim() === EXPRESSAO;
}

/** A regra que a automação cria. */
function regraNova() {
  return { ref: REF, description: DESCRICAO, expression: EXPRESSAO, action: ACAO, enabled: true };
}

/**
 * O que fazer numa zona, dado o conjunto de regras lido e o modo.
 *
 * `conjunto` é `null` quando a Cloudflare respondeu 404 no entrypoint (a zona
 * nunca teve regras personalizadas). A simulação decide exatamente como a
 * aplicação — quem chama é que não executa a escrita.
 *
 * @returns {{ resultado: string, escrita: object | null }}
 */
function decidir({ modo, conjunto }) {
  const regras = conjunto?.rules || [];
  const nossa = regras.find((r) => r.ref === REF);

  if (modo === 'remover') {
    if (!conjunto || !nossa) return { resultado: 'nada_a_remover', escrita: null };
    return { resultado: 'removida', escrita: { tipo: 'apagar', conjuntoId: conjunto.id, regraId: nossa.id } };
  }

  // simular e aplicar decidem igual
  if (!conjunto) return { resultado: 'criada', escrita: { tipo: 'criar_conjunto' } };

  if (nossa) {
    if (nossa.enabled === false) {
      return { resultado: 'reativada', escrita: { tipo: 'reativar', conjuntoId: conjunto.id, regra: nossa } };
    }
    return { resultado: 'ja_existia', escrita: null };
  }

  const manual = regras.find((r) => r.action === ACAO && r.enabled !== false && mesmaExpressao(r.expression));
  if (manual) return { resultado: 'ja_existia', escrita: null };

  if (regras.length >= LIMITE_REGRAS_ZONA) return { resultado: 'limite', escrita: null };

  return { resultado: 'criada', escrita: { tipo: 'criar_regra', conjuntoId: conjunto.id } };
}

/**
 * Relatório do lote: um item por domínio, na ordem pedida, e a contagem por
 * resultado.
 */
function montarRelatorio(modo, itens) {
  const totais = {};
  for (const item of itens) totais[item.resultado] = (totais[item.resultado] || 0) + 1;
  return { modo, total: itens.length, totais, dominios: itens };
}

/**
 * Texto do alerta de falha, ou `null` quando não há o que avisar: simulação
 * nunca alerta, e lote sem `erro` também não.
 */
function resumoDeFalhas(relatorio) {
  if (!relatorio || relatorio.modo === 'simular') return null;
  const falhas = relatorio.dominios.filter((d) => d.resultado === 'erro');
  if (falhas.length === 0) return null;

  const acao = relatorio.modo === 'aplicar' ? 'aplicar' : 'remover';
  const linhas = falhas.map((f) => `• ${f.dominio}: ${f.erro || 'erro sem detalhe'}`);
  return [
    '🛡️ *Antibot em lote*',
    '',
    `Falha ao ${acao} a regra em ${falhas.length} de ${relatorio.total} domínio(s):`,
    ...linhas,
    '',
    'Os demais domínios do lote foram processados normalmente.',
  ].join('\n');
}

module.exports = {
  LIMITE_LOTE,
  LIMITE_REGRAS_ZONA,
  MODOS,
  MODO_PADRAO,
  FASE,
  REF,
  DESCRICAO,
  EXPRESSAO,
  ACAO,
  normalizarPedido,
  mesmaExpressao,
  regraNova,
  decidir,
  montarRelatorio,
  resumoDeFalhas,
};
