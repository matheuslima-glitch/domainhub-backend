/**
 * PROVAS DO ANTIBOT EM LOTE
 *
 *   npm run testa:antibot
 *
 * Duas partes:
 *   1. a lógica pura (antibot-regras.js), caso a caso;
 *   2. a rota de verdade em express, contra uma Cloudflare e um Supabase
 *      falsos. Sem rede e sem credencial: qualquer chamada que a Cloudflare
 *      falsa não conheça derruba a prova em vez de sair para a internet.
 *
 * O que mais importa contar são as ESCRITAS na Cloudflare (PUT, POST, PATCH,
 * DELETE): zero na simulação e em toda recusa, e o PUT do conjunto nunca
 * numa zona que já tem regras — ele substituiria todas.
 *
 * Mudança OpenSpec: openspec/changes/antibot-em-lote.
 */

Object.assign(process.env, {
  SUPABASE_URL: 'http://supabase-falso.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'falsa',
  SUPABASE_USER_ID: 'falso',
  NAMECHEAP_API_USER: 'falso',
  NAMECHEAP_API_KEY: 'falsa',
  NAMECHEAP_CLIENT_IP: '127.0.0.1',
  CLOUDFLARE_EMAIL: 'falso@exemplo.invalid',
  CLOUDFLARE_API_KEY: 'falsa',
  CLOUDFLARE_ACCOUNT_ID: 'conta-atual',
  CLOUDFLARE_MAIN_ZONE_ID: 'zona-principal',
});

const imprimir = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const provas = [];
const ok = (rot, cond, det) => provas.push({ rot, cond: !!cond, detalhe: det });

const R = require('../services/cloudflare/antibot-regras');

// ══════════════════════════════════════════════════════════════════════════
// 1. LÓGICA PURA
// ══════════════════════════════════════════════════════════════════════════

function provasPuras() {
  // ── 1.1 pedido ─────────────────────────────────────────────────────────
  const vazio = R.normalizarPedido({ dominios: [] });
  ok('lista vazia é recusada', !vazio.ok && /ao menos um/.test(vazio.erro), vazio);

  const semCampo = R.normalizarPedido({});
  ok('pedido sem "dominios" é recusado', !semCampo.ok, semCampo);

  const muitos = Array.from({ length: 51 }, (_, i) => `d${i}.com`);
  const grande = R.normalizarPedido({ dominios: muitos });
  ok('51 domínios são recusados', !grande.ok && /No máximo 50/.test(grande.erro), grande);

  const cinquenta = R.normalizarPedido({ dominios: muitos.slice(0, 50) });
  ok('50 domínios são aceitos', cinquenta.ok && cinquenta.dominios.length === 50, cinquenta.erro);

  const repetidos = R.normalizarPedido({ dominios: ['  Exemplo.COM ', 'exemplo.com', 'outro.site'] });
  ok('repetidos com caixa e espaço viram um só',
    repetidos.ok && JSON.stringify(repetidos.dominios) === '["exemplo.com","outro.site"]', repetidos);

  const texto = R.normalizarPedido({ dominios: 'a.com\nb.online\r\n c.site, a.com' });
  ok('lista colada como texto é aceita',
    texto.ok && JSON.stringify(texto.dominios) === '["a.com","b.online","c.site"]', texto);

  const invalido = R.normalizarPedido({ dominios: ['bom.com', 'https://ruim.com/x', 'semponto'] });
  ok('nome inválido recusa o pedido inteiro',
    !invalido.ok && /ruim\.com/.test(invalido.erro) && /semponto/.test(invalido.erro), invalido);

  const modoRuim = R.normalizarPedido({ dominios: ['a.com'], modo: 'apagar-tudo' });
  ok('modo desconhecido é recusado', !modoRuim.ok && /Modo desconhecido/.test(modoRuim.erro), modoRuim);

  const semModo = R.normalizarPedido({ dominios: ['a.com'] });
  ok('sem modo, o padrão é simular', semModo.ok && semModo.modo === 'simular', semModo);

  const modoCaixa = R.normalizarPedido({ dominios: ['a.com'], modo: ' Aplicar ' });
  ok('modo aceita caixa e espaço', modoCaixa.ok && modoCaixa.modo === 'aplicar', modoCaixa);

  // ── 1.2 decisão por zona ───────────────────────────────────────────────
  const nossaAtiva = { id: 'r1', ref: R.REF, action: R.ACAO, expression: R.EXPRESSAO, enabled: true };
  const nossaDesligada = { ...nossaAtiva, enabled: false };
  const manual = { id: 'm1', description: 'Antibot-teste', action: 'managed_challenge',
    expression: '(http.host   wildcard r"*")', enabled: true };
  const unused = (id) => ({ id, description: 'Unused filter', action: 'block',
    expression: '(http.request.uri contains "sitemap")', enabled: false });

  const semConjunto = R.decidir({ modo: 'aplicar', conjunto: null });
  ok('zona sem conjunto: cria o conjunto',
    semConjunto.resultado === 'criada' && semConjunto.escrita?.tipo === 'criar_conjunto', semConjunto);

  const comUnused = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [unused('u1'), unused('u2')] } });
  ok('zona com 2 regras: cria a regra no conjunto existente',
    comUnused.resultado === 'criada' && comUnused.escrita?.tipo === 'criar_regra' && comUnused.escrita.conjuntoId === 'c',
    comUnused);

  const jaTem = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [nossaAtiva] } });
  ok('nossa regra ativa: ja_existia sem escrita', jaTem.resultado === 'ja_existia' && jaTem.escrita === null, jaTem);

  const desligada = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [nossaDesligada] } });
  ok('nossa regra desativada: reativada',
    desligada.resultado === 'reativada' && desligada.escrita?.tipo === 'reativar' && desligada.escrita.regra.id === 'r1',
    desligada);

  const comManual = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [manual, unused('u1')] } });
  ok('regra equivalente feita à mão: ja_existia sem escrita',
    comManual.resultado === 'ja_existia' && comManual.escrita === null, comManual);

  const manualDesligada = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [{ ...manual, enabled: false }] } });
  ok('regra feita à mão DESATIVADA não conta: cria a nossa', manualDesligada.resultado === 'criada', manualDesligada);

  const outraAcao = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [{ ...manual, action: 'block' }] } });
  ok('mesma expressão com outra ação não conta: cria a nossa', outraAcao.resultado === 'criada', outraAcao);

  const cinco = Array.from({ length: 5 }, (_, i) => unused(`u${i}`));
  const cheia = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: cinco } });
  ok('zona com 5 regras (mesmo desativadas): limite sem escrita',
    cheia.resultado === 'limite' && cheia.escrita === null, cheia);

  const quatro = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: cinco.slice(0, 4) } });
  ok('zona com 4 regras: ainda cabe', quatro.resultado === 'criada', quatro);

  const cheiaComNossa = R.decidir({ modo: 'aplicar', conjunto: { id: 'c', rules: [...cinco.slice(0, 4), nossaAtiva] } });
  ok('zona cheia que já tem a nossa: ja_existia, não limite', cheiaComNossa.resultado === 'ja_existia', cheiaComNossa);

  const simula = R.decidir({ modo: 'simular', conjunto: null });
  ok('simular decide igual a aplicar', simula.resultado === 'criada' && simula.escrita?.tipo === 'criar_conjunto', simula);

  const remove = R.decidir({ modo: 'remover', conjunto: { id: 'c', rules: [manual, nossaAtiva] } });
  ok('remover com a nossa: apaga só ela',
    remove.resultado === 'removida' && remove.escrita?.tipo === 'apagar' && remove.escrita.regraId === 'r1', remove);

  const removeSo = R.decidir({ modo: 'remover', conjunto: { id: 'c', rules: [manual] } });
  ok('remover sem a nossa (só a manual): nada_a_remover', removeSo.resultado === 'nada_a_remover' && !removeSo.escrita, removeSo);

  const removeVazio = R.decidir({ modo: 'remover', conjunto: null });
  ok('remover em zona sem conjunto: nada_a_remover', removeVazio.resultado === 'nada_a_remover', removeVazio);

  const regra = R.regraNova();
  ok('regra nova: ref, descrição, desafio gerenciado, expressão e ativa',
    regra.ref === 'domainhub-antibot' && regra.description === 'Antibot (DomainHub)' &&
    regra.action === 'managed_challenge' && regra.expression === '(http.host wildcard r"*")' && regra.enabled === true,
    regra);

  // ── 1.3 relatório e resumo ─────────────────────────────────────────────
  const itens = [
    { dominio: 'a.com', resultado: 'criada' },
    { dominio: 'b.com', resultado: 'ja_existia' },
    { dominio: 'c.com', resultado: 'erro', erro: 'HTTP 500' },
    { dominio: 'd.com', resultado: 'criada' },
  ];
  const rel = R.montarRelatorio('aplicar', itens);
  ok('relatório: cada domínio uma vez, na ordem',
    rel.total === 4 && rel.dominios.map((d) => d.dominio).join() === 'a.com,b.com,c.com,d.com', rel);
  ok('relatório: contagem por resultado',
    rel.totais.criada === 2 && rel.totais.ja_existia === 1 && rel.totais.erro === 1, rel.totais);

  const resumo = R.resumoDeFalhas(rel);
  ok('resumo de falha cita o domínio e o erro',
    typeof resumo === 'string' && resumo.includes('c.com: HTTP 500') && resumo.includes('1 de 4'), resumo);
  ok('resumo não cita os domínios que deram certo', resumo && !resumo.includes('a.com'), resumo);

  ok('simulação com erro não gera alerta', R.resumoDeFalhas(R.montarRelatorio('simular', itens)) === null);
  ok('lote sem erro não gera alerta',
    R.resumoDeFalhas(R.montarRelatorio('aplicar', [{ dominio: 'a.com', resultado: 'criada' }])) === null);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. ROTA DE VERDADE CONTRA A CLOUDFLARE FALSA (preenchido nas tarefas 2 e 3)
// ══════════════════════════════════════════════════════════════════════════

// ── dublês: Supabase (cargo e tabela domains) e distribuidor de alertas ──

let cargo = { data: true, error: null };
let base = [];
let erroDaBase = null;
require.cache[require.resolve('@supabase/supabase-js')] = {
  exports: {
    createClient: () => ({
      rpc: async () => cargo,
      from: () => ({
        select: () => ({
          in: async (_coluna, lista) => (erroDaBase
            ? { data: null, error: erroDaBase }
            : { data: base.filter((d) => lista.includes(d)).map((d) => ({ domain_name: d })), error: null }),
        }),
      }),
    }),
  },
};

let alertas = [];
require.cache[require.resolve('../services/notify')] = {
  exports: {
    espelhar: async (mensagem, opts) => { alertas.push({ mensagem, opts }); return []; },
    espelharEmSegundoPlano: () => {},
    send: async () => [],
  },
};

// A pausa entre domínios vira zero, para a prova não esperar à toa.
const setTimeoutReal = global.setTimeout;
global.setTimeout = (funcao, ms, ...resto) => setTimeoutReal(funcao, ms === 250 ? 0 : ms, ...resto);

// ── a Cloudflare falsa ───────────────────────────────────────────────────

const axios = require('axios');

let zonas = new Map(); // nome -> { id, conjunto: null | { id, rules }, falhaLeitura }
let chamadas = [];
let putSobreConjunto = 0;
let seq = 0;

const ESCRITAS = ['PUT', 'POST', 'PATCH', 'DELETE'];
const escritas = (trecho = '') => chamadas.filter((c) => ESCRITAS.includes(c.metodo) && c.caminho.includes(trecho)).length;
const contar = (metodo, trecho) => chamadas.filter((c) => c.metodo === metodo && c.caminho.includes(trecho)).length;

function zona(nome, { conjunto = null, falhaLeitura = false, id } = {}) {
  zonas.set(nome, { id: id || `z-${nome}`, nome, conjunto, falhaLeitura });
}
const porId = (id) => [...zonas.values()].find((z) => z.id === id);
const resposta = (status, data) => ({ status, data });
const sucesso = (result) => resposta(200, { success: true, errors: [], result });

function cloudflareFalsa(metodo, caminho, corpo) {
  let m;
  if (metodo === 'GET' && caminho === '/zones/zona-principal') {
    return sucesso({ id: 'zona-principal', name: 'institutoexperience.com.br' });
  }
  if (metodo === 'GET' && (m = caminho.match(/^\/zones\?name=(.+)$/))) {
    const z = zonas.get(decodeURIComponent(m[1]));
    return sucesso(z ? [{ id: z.id, name: z.nome }] : []);
  }
  if ((m = caminho.match(/^\/zones\/([^/]+)\/rulesets\/phases\/http_request_firewall_custom\/entrypoint$/))) {
    const z = porId(m[1]);
    if (!z) throw new Error(`zona desconhecida ${m[1]}`);
    if (metodo === 'GET') {
      if (z.falhaLeitura) return resposta(500, { success: false, errors: [{ code: 10000, message: 'falha interna' }] });
      if (!z.conjunto) return resposta(404, { success: false, errors: [{ code: 10003, message: 'could not find entrypoint ruleset' }] });
      return sucesso(JSON.parse(JSON.stringify(z.conjunto)));
    }
    if (metodo === 'PUT') {
      if (z.conjunto) putSobreConjunto += 1;
      z.conjunto = { id: `cj-${z.id}`, rules: corpo.rules.map((r) => ({ id: `r${++seq}`, ...r })) };
      return sucesso(z.conjunto);
    }
  }
  if ((m = caminho.match(/^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/))) {
    const z = porId(m[1]);
    if (!z || !z.conjunto || z.conjunto.id !== m[2]) throw new Error(`conjunto desconhecido ${caminho}`);
    const regras = z.conjunto.rules;
    if (metodo === 'POST' && !m[3]) {
      const { position, ...regra } = corpo;
      const indice = position?.index ? position.index - 1 : regras.length;
      regras.splice(indice, 0, { id: `r${++seq}`, ...regra });
      return sucesso(z.conjunto);
    }
    const i = regras.findIndex((r) => r.id === m[3]);
    if (i < 0) throw new Error(`regra desconhecida ${caminho}`);
    if (metodo === 'PATCH') { regras[i] = { ...regras[i], ...corpo }; return sucesso(z.conjunto); }
    if (metodo === 'DELETE') { regras.splice(i, 1); return sucesso(z.conjunto); }
  }
  throw new Error(`chamada não prevista: ${metodo} ${caminho}`);
}

axios.defaults.adapter = async (cfg) => {
  const caminho = cfg.url.replace('https://api.cloudflare.com/client/v4', '');
  const metodo = cfg.method.toUpperCase();
  const corpo = cfg.data ? JSON.parse(cfg.data) : undefined;
  chamadas.push({ metodo, caminho, corpo, cabecalhos: cfg.headers });
  await new Promise((r) => setTimeoutReal(r, 5));
  const { status, data } = cloudflareFalsa(metodo, caminho, corpo);
  return { data, status, statusText: String(status), headers: {}, config: cfg };
};

// ── cenários ──────────────────────────────────────────────────────────────

const NOSSA = (enabled = true) => ({ id: 'nossa', ref: R.REF, description: R.DESCRICAO,
  action: R.ACAO, expression: R.EXPRESSAO, enabled });
const UNUSED = (id) => ({ id, description: 'Unused filter', action: 'block',
  expression: '(http.request.uri contains "sitemap")', enabled: false });
const MANUAL = { id: 'manual', description: 'Antibot-teste', action: 'managed_challenge',
  expression: '(http.host wildcard r"*")', enabled: true };

function mundoPadrao() {
  zonas = new Map();
  chamadas = [];
  alertas = [];
  putSobreConjunto = 0;
  cargo = { data: true, error: null };
  erroDaBase = null;
  base = ['nova.com', 'velha.com', 'cheia.com', 'manual.com', 'semzona.com',
    'a-ok.com', 'falha.com', 'b-ok.com', 'apelido.com'];
  zona('nova.com');
  zona('velha.com', { conjunto: { id: 'cj-velha', rules: [UNUSED('u1'), UNUSED('u2')] } });
  zona('cheia.com', { conjunto: { id: 'cj-cheia', rules: [1, 2, 3, 4, 5].map((n) => UNUSED(`c${n}`)) } });
  zona('manual.com', { conjunto: { id: 'cj-manual', rules: [MANUAL, UNUSED('u3')] } });
  zona('a-ok.com');
  zona('falha.com', { falhaLeitura: true });
  zona('b-ok.com');
  zona('apelido.com', { id: 'zona-principal' });
}

const resultadoDe = (corpo, dominio) => corpo.dominios?.find((d) => d.dominio === dominio);

async function provasDaRota() {
  const express = require('express');
  const rotas = require('../routes/antibot');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'pessoa-teste' }; next(); });
  app.use('/api/antibot', rotas);
  const servidor = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${servidor.address().port}/api/antibot/lote`;
  const post = async (corpo) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    return { status: r.status, corpo: await r.json() };
  };

  const TODOS = ['nova.com', 'velha.com', 'cheia.com', 'manual.com', 'fora.com', 'institutoexperience.com.br', 'semzona.com'];

  // ── trava de super admin (3.1) ─────────────────────────────────────────
  mundoPadrao();
  cargo = { data: false, error: null };
  let r = await post({ dominios: ['nova.com'], modo: 'aplicar' });
  ok('não super admin: 403 e nenhuma chamada à Cloudflare', r.status === 403 && chamadas.length === 0, r);

  mundoPadrao();
  cargo = { data: null, error: { message: 'banco fora' } };
  r = await post({ dominios: ['nova.com'], modo: 'aplicar' });
  ok('cargo não conferido: 503 e nenhuma chamada', r.status === 503 && chamadas.length === 0, r);

  // ── validação (3.1) ────────────────────────────────────────────────────
  mundoPadrao();
  r = await post({ dominios: [] });
  ok('lista vazia: 400 sem chamada', r.status === 400 && chamadas.length === 0, r);
  r = await post({ dominios: Array.from({ length: 51 }, (_, i) => `d${i}.com`) });
  ok('51 domínios: 400 sem chamada', r.status === 400 && chamadas.length === 0, r);
  r = await post({ dominios: ['nova.com'], modo: 'destruir' });
  ok('modo desconhecido: 400 sem chamada', r.status === 400 && chamadas.length === 0, r);

  mundoPadrao();
  erroDaBase = { message: 'timeout' };
  r = await post({ dominios: ['nova.com'], modo: 'aplicar' });
  ok('base de domínios fora do ar: 503 sem escrita', r.status === 503 && escritas() === 0, r);

  // ── simulação padrão (2.1, 2.2) ────────────────────────────────────────
  mundoPadrao();
  r = await post({ dominios: TODOS });
  const sim = r.corpo;
  ok('sem modo: roda como simulação', r.status === 200 && sim.modo === 'simular', r);
  ok('simulação: ZERO escritas na Cloudflare', escritas() === 0, chamadas.map((c) => `${c.metodo} ${c.caminho}`));
  ok('simulação: prevê criada na zona sem conjunto',
    resultadoDe(sim, 'nova.com')?.resultado === 'criada' && resultadoDe(sim, 'nova.com')?.simulado === true, sim);
  ok('simulação: prevê criada na zona com Unused filter', resultadoDe(sim, 'velha.com')?.resultado === 'criada', sim);
  ok('simulação: zona cheia sai como limite', resultadoDe(sim, 'cheia.com')?.resultado === 'limite', sim);
  ok('simulação: regra manual equivalente sai como ja_existia', resultadoDe(sim, 'manual.com')?.resultado === 'ja_existia', sim);
  ok('domínio fora da base: desconhecido', resultadoDe(sim, 'fora.com')?.resultado === 'desconhecido', sim);
  ok('domínio fora da base: nenhuma chamada à Cloudflare para ele', contar('GET', 'name=fora.com') === 0);
  ok('zona principal pelo nome: recusado, mesmo fora da base',
    resultadoDe(sim, 'institutoexperience.com.br')?.resultado === 'recusado' && contar('GET', 'name=institutoexperience') === 0, sim);
  ok('domínio sem zona: sem_zona', resultadoDe(sim, 'semzona.com')?.resultado === 'sem_zona', sim);
  ok('relatório: cada domínio pedido uma vez, com totais',
    sim.total === TODOS.length && sim.dominios.length === TODOS.length && sim.totais.criada === 2, sim.totais);
  ok('simulação nunca alerta', alertas.length === 0, alertas);

  const cab = chamadas[0]?.cabecalhos || {};
  ok('usa a chave global (X-Auth-Email + X-Auth-Key), não Bearer',
    cab['X-Auth-Email'] === 'falso@exemplo.invalid' && cab['X-Auth-Key'] === 'falsa' && !cab.Authorization, cab);

  // ── aplicação (2.2) ────────────────────────────────────────────────────
  r = await post({ dominios: TODOS, modo: 'aplicar' });
  const apl = r.corpo;
  ok('aplicar: 200 e modo aplicar', r.status === 200 && apl.modo === 'aplicar', r);
  ok('aplicar: zona sem conjunto recebe PUT com a nossa regra',
    resultadoDe(apl, 'nova.com')?.resultado === 'criada' && contar('PUT', 'z-nova.com') === 1 &&
    zonas.get('nova.com').conjunto.rules.length === 1 && zonas.get('nova.com').conjunto.rules[0].ref === R.REF, zonas.get('nova.com'));
  const postVelha = chamadas.find((c) => c.metodo === 'POST' && c.caminho.includes('z-velha.com'));
  ok('aplicar: zona com conjunto recebe POST, sem PUT',
    resultadoDe(apl, 'velha.com')?.resultado === 'criada' && postVelha && contar('PUT', 'z-velha.com') === 0, postVelha);
  ok('aplicar: a regra vai em primeiro, com ref, descrição, ação e expressão',
    postVelha?.corpo?.position?.index === 1 && postVelha.corpo.ref === 'domainhub-antibot' &&
    postVelha.corpo.description === 'Antibot (DomainHub)' && postVelha.corpo.action === 'managed_challenge' &&
    postVelha.corpo.expression === '(http.host wildcard r"*")' && postVelha.corpo.enabled === true, postVelha?.corpo);
  ok('aplicar: Unused filter da zona continuam lá, depois da nossa',
    zonas.get('velha.com').conjunto.rules.map((x) => x.id).slice(1).join() === 'u1,u2', zonas.get('velha.com').conjunto.rules);
  ok('aplicar: zona cheia não recebe escrita', escritas('cj-cheia') === 0 && resultadoDe(apl, 'cheia.com')?.resultado === 'limite');
  ok('aplicar: zona com regra manual não recebe escrita', escritas('cj-manual') === 0 && resultadoDe(apl, 'manual.com')?.resultado === 'ja_existia');
  ok('o PUT NUNCA cai sobre um conjunto existente', putSobreConjunto === 0, putSobreConjunto);
  ok('aplicar sem erro: nenhum alerta', alertas.length === 0, alertas);

  // ── idempotência ───────────────────────────────────────────────────────
  chamadas = [];
  r = await post({ dominios: ['nova.com', 'velha.com', 'manual.com'], modo: 'aplicar' });
  ok('rodar de novo: ja_existia e ZERO escritas',
    r.corpo.dominios.every((d) => d.resultado === 'ja_existia') && escritas() === 0, r.corpo);

  // ── reativar ───────────────────────────────────────────────────────────
  zonas.get('velha.com').conjunto.rules[0].enabled = false;
  chamadas = [];
  r = await post({ dominios: ['velha.com'], modo: 'aplicar' });
  const patch = chamadas.find((c) => c.metodo === 'PATCH');
  ok('nossa regra desligada: reativada por PATCH com enabled true',
    resultadoDe(r.corpo, 'velha.com')?.resultado === 'reativada' && patch?.corpo?.enabled === true &&
    patch.corpo.expression === R.EXPRESSAO && escritas() === 1, patch);

  // ── remoção ────────────────────────────────────────────────────────────
  chamadas = [];
  r = await post({ dominios: ['velha.com', 'manual.com', 'nova.com', 'cheia.com'], modo: 'remover' });
  const rem = r.corpo;
  ok('remover: apaga a nossa e só ela',
    resultadoDe(rem, 'velha.com')?.resultado === 'removida' &&
    zonas.get('velha.com').conjunto.rules.map((x) => x.id).join() === 'u1,u2', zonas.get('velha.com').conjunto);
  ok('remover: regra feita à mão fica intacta',
    resultadoDe(rem, 'manual.com')?.resultado === 'nada_a_remover' &&
    zonas.get('manual.com').conjunto.rules.some((x) => x.id === 'manual'), zonas.get('manual.com').conjunto);
  ok('remover: zona criada pela automação perde a regra', resultadoDe(rem, 'nova.com')?.resultado === 'removida');
  ok('remover: zona sem a nossa não recebe escrita', resultadoDe(rem, 'cheia.com')?.resultado === 'nada_a_remover' && escritas('cj-cheia') === 0);
  ok('remover: só DELETE, nenhum PUT/POST/PATCH',
    contar('DELETE', '') === 2 && contar('PUT', '') + contar('POST', '') + contar('PATCH', '') === 0);

  // ── falha isolada e alerta (2.3) ───────────────────────────────────────
  mundoPadrao();
  r = await post({ dominios: ['a-ok.com', 'falha.com', 'b-ok.com'], modo: 'aplicar' });
  ok('falha no meio: os outros seguem',
    resultadoDe(r.corpo, 'a-ok.com')?.resultado === 'criada' && resultadoDe(r.corpo, 'b-ok.com')?.resultado === 'criada', r.corpo);
  ok('falha no meio: o domínio sai como erro, com a mensagem da Cloudflare',
    resultadoDe(r.corpo, 'falha.com')?.resultado === 'erro' && /HTTP 500/.test(resultadoDe(r.corpo, 'falha.com')?.erro), r.corpo);
  ok('falha: exatamente UM alerta, crítico, citando o domínio',
    alertas.length === 1 && alertas[0].opts?.critico === true && alertas[0].mensagem.includes('falha.com'), alertas);

  mundoPadrao();
  r = await post({ dominios: ['a-ok.com', 'falha.com'], modo: 'simular' });
  ok('simulação com falha: nenhum alerta', resultadoDe(r.corpo, 'falha.com')?.resultado === 'erro' && alertas.length === 0, alertas);

  mundoPadrao();
  r = await post({ dominios: ['apelido.com'], modo: 'aplicar' });
  ok('zona com o id da principal: recusado sem escrita',
    resultadoDe(r.corpo, 'apelido.com')?.resultado === 'recusado' && escritas() === 0, r.corpo);

  // ── dois lotes ao mesmo tempo (2.3) ────────────────────────────────────
  mundoPadrao();
  const [um, dois] = await Promise.all([
    post({ dominios: ['nova.com', 'velha.com', 'a-ok.com', 'b-ok.com'], modo: 'aplicar' }),
    post({ dominios: ['nova.com'], modo: 'aplicar' }),
  ]);
  const status = [um.status, dois.status].sort().join();
  ok('dois lotes simultâneos: um roda, o outro recebe 409', status === '200,409', [um, dois]);
  ok('lote simultâneo recusado não duplicou nada',
    zonas.get('nova.com').conjunto.rules.filter((x) => x.ref === R.REF).length === 1, zonas.get('nova.com'));

  // ── o comando documentado na rota (3.3) ────────────────────────────────
  mundoPadrao();
  r = await post({ dominios: 'nova.com\nvelha.com', modo: 'simular' });
  ok('corpo do comando documentado (texto com um domínio por linha) funciona',
    r.status === 200 && r.corpo.total === 2 && escritas() === 0, r);

  const fs = require('fs');
  const cabecalhoRota = fs.readFileSync(require.resolve('../routes/antibot'), 'utf8');
  ok('cabeçalho da rota documenta os três modos e o endereço',
    ['simular', 'aplicar', 'remover', '/api/antibot/lote', 'sb-domainhub-auth'].every((t) => cabecalhoRota.includes(t)));

  // ── montagem no server.js (3.2) ────────────────────────────────────────
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  const publicas = (server.match(/publicPaths = \[([^\]]*)\]/) || [])[1] || '';
  const posAuth = server.indexOf('authMiddleware(req, res, next)');
  const posMontagem = server.indexOf("app.use('/api/antibot', require('./routes/antibot'))");
  ok('rota montada depois da autenticação e fora das rotas públicas',
    posMontagem > posAuth && posAuth > 0 && !publicas.includes('antibot'), { posAuth, posMontagem, publicas });

  servidor.close();
}

async function principal() {
  provasPuras();
  await provasDaRota();

  const falhas = provas.filter((p) => !p.cond);
  for (const p of provas) {
    imprimir(`  ${p.cond ? 'ok  ' : 'FALHA'} ${p.rot}`);
    if (!p.cond && p.detalhe !== undefined) imprimir(`        ${JSON.stringify(p.detalhe).slice(0, 400)}`);
  }
  imprimir(`\n${provas.length} provas, ${falhas.length} falha(s).`);
  process.exit(falhas.length ? 1 : 0);
}

principal().catch((e) => {
  imprimir('ERRO FATAL NA PROVA:', e);
  process.exit(1);
});
