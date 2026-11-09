/**
 * PROVAS DO REGISTRO DE TESTE DO CLOUDFLARE REGISTRAR
 *
 *   npm run testa:registro
 *
 * Roda as rotas de verdade contra uma Cloudflare falsa. Sem rede e sem
 * credencial: as variáveis abaixo são de mentira, e qualquer chamada que a
 * Cloudflare falsa não conheça derruba a prova em vez de sair para a internet.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────
 *
 * A rota `registro-teste` gasta dinheiro, sem reembolso. O que mais importa
 * aqui é contar os pedidos de compra: em cada recusa, ZERO; quando passa,
 * exatamente UM, mesmo com o registro demorando ou a rede caindo.
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
  CLOUDFLARE_REGISTRAR_ACCOUNT_ID: 'conta-nova',
  CLOUDFLARE_REGISTRAR_API_TOKEN: 'falso',
  REGISTRO_TESTE_LIGADO: 'true',
});

const imprimir = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// O atraso entre consultas de status vira zero, para a prova não levar 1 minuto.
const setTimeoutReal = global.setTimeout;
global.setTimeout = (funcao, ms, ...resto) => setTimeoutReal(funcao, ms === 5000 ? 0 : ms, ...resto);

// ── dublês: cargo no Supabase e teto do fluxo de compra ──────────────────

const cargo = { data: true, error: null };
require.cache[require.resolve('@supabase/supabase-js')] = {
  exports: { createClient: () => ({ rpc: async () => cargo }) },
};
require.cache[require.resolve('../purchase-domains/wordpress')] = {
  exports: class { constructor() { this.priceLimit = 5; } },
};

const axios = require('axios');
const express = require('express');
const config = require('../config/env');
const rotas = require('../routes/registrar');
const {
  nomeCom,
  motivoParaRecusarPedido,
  motivoParaRecusarConsulta,
  interpretarRegistro,
  resumirApontamento,
} = require('../services/cloudflare/registrar-resposta');

// ── a Cloudflare falsa ───────────────────────────────────────────────────

const SERVIDOR = 'servidor.institutoexperience.com.br';
const CONTA_NOVA = '/accounts/conta-nova/registrar';

let chamadas = [];
let responder = () => { throw new Error('cenário sem resposta definida'); };

const contar = (metodo, trecho) => chamadas
  .filter((c) => c.metodo === metodo && c.caminho.includes(trecho)).length;
const compras = () => contar('POST', '/registrar/registrations');

axios.defaults.adapter = async (cfg) => {
  const caminho = cfg.url.replace('https://api.cloudflare.com/client/v4', '');
  const metodo = cfg.method.toUpperCase();
  const corpo = cfg.data ? JSON.parse(cfg.data) : undefined;
  chamadas.push({ metodo, caminho, corpo, cabecalhos: cfg.headers });
  await new Promise((r) => setTimeoutReal(r, 5));
  return { data: responder(metodo, caminho, corpo), status: 200, statusText: 'OK', headers: {}, config: cfg };
};

const consulta = (sobre = {}) => ({
  success: true,
  result: {
    domains: [{
      name: 'teste-gex.com',
      registrable: true,
      tier: 'standard',
      pricing: { currency: 'USD', registration_cost: '10.44', renewal_cost: '10.44' },
      ...sobre,
    }],
  },
});

const fluxo = (state, extra = {}) => ({
  success: true,
  result: {
    state,
    completed: state === 'succeeded' || state === 'failed',
    context: state === 'succeeded'
      ? { registration: { expires_at: '2027-11-05T10:00:00Z', auto_renew: false } }
      : undefined,
    ...extra,
  },
});

const provas = [];
const ok = (rot, cond, det) => provas.push({ rot, cond: !!cond, detalhe: det });

async function principal() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'pessoa-teste' }; next(); });
  app.use('/api/registrar', rotas);
  const servidor = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/registrar`;

  const post = async (rota, corpo) => {
    const r = await fetch(`${base}/${rota}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    return { status: r.status, corpo: await r.json() };
  };
  const comprar = (dominio = 'teste-gex.com', confirmar = dominio) => post('registro-teste', { dominio, confirmar });
  const novoCenario = (fn) => { chamadas = []; responder = fn; };
  const compraNormal = (metodo, caminho) => {
    if (caminho.endsWith('/domain-check')) return consulta();
    if (metodo === 'POST' && caminho.endsWith('/registrations')) return fluxo('succeeded');
    throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
  };

  // ── travas da rota ──────────────────────────────────────────────────

  novoCenario(compraNormal);
  config.REGISTRO_TESTE_LIGADO = false;
  let r = await comprar();
  ok('interruptor desligado barra antes de falar com a Cloudflare',
    r.status === 403 && chamadas.length === 0, JSON.stringify(r));
  config.REGISTRO_TESTE_LIGADO = true;

  novoCenario(compraNormal);
  cargo.data = false;
  r = await comprar();
  ok('quem nao e super admin nao compra', r.status === 403 && chamadas.length === 0, JSON.stringify(r));

  cargo.data = null;
  cargo.error = { message: 'banco fora' };
  r = await comprar();
  ok('sem conseguir conferir o cargo, barra', r.status === 503 && chamadas.length === 0, JSON.stringify(r));
  cargo.data = true;
  cargo.error = null;

  novoCenario(compraNormal);
  r = await comprar('teste-gex.com', 'outro.com');
  ok('`confirmar` diferente recusa, sem chamar nada', r.status === 400 && chamadas.length === 0);
  r = await post('registro-teste', { dominio: 'teste-gex.com' });
  ok('sem `confirmar` recusa', r.status === 400 && chamadas.length === 0);
  r = await comprar('teste-gex.site');
  ok('so aceita .com', r.status === 400 && chamadas.length === 0);

  // ── a consulta de antes da compra ───────────────────────────────────

  for (const [rotulo, sobre] of [
    ['preco acima do teto', { pricing: { currency: 'USD', registration_cost: '12.01', renewal_cost: '12.01' } }],
    ['nome premium', { tier: 'premium' }],
    ['nome tomado', { registrable: false, reason: 'domain_unavailable' }],
    ['moeda diferente', { pricing: { currency: 'EUR', registration_cost: '9.00', renewal_cost: '9.00' } }],
    ['preco ausente', { pricing: undefined }],
  ]) {
    novoCenario((m, c) => {
      if (c.endsWith('/domain-check')) return consulta(sobre);
      throw new Error(`chamada inesperada: ${m} ${c}`);
    });
    r = await comprar();
    ok(`${rotulo}: consulta e NAO compra`,
      r.status === 400 && compras() === 0 && contar('POST', '/domain-check') === 1, JSON.stringify(r));
  }

  novoCenario((m, c) => {
    if (c.endsWith('/domain-check')) return { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] };
    throw new Error(`chamada inesperada: ${m} ${c}`);
  });
  r = await comprar();
  ok('token recusado na consulta: nao compra', r.status === 400 && compras() === 0 && r.corpo.erro.includes('9109'));

  // ── a compra ────────────────────────────────────────────────────────

  novoCenario(compraNormal);
  r = await comprar();
  ok('caminho feliz compra exatamente UMA vez', r.status === 200 && compras() === 1, JSON.stringify(r));
  const pedido = chamadas.find((c) => c.metodo === 'POST' && c.caminho.endsWith('/registrations'));
  ok('compra na CONTA NOVA', pedido.caminho === `${CONTA_NOVA}/registrations`, pedido.caminho);
  ok('com o token da conta nova, nao a chave global',
    pedido.cabecalhos.Authorization === 'Bearer falso' && !pedido.cabecalhos['X-Auth-Key']);
  ok('renovacao automatica vai DESLIGADA, de forma explicita',
    pedido.corpo.auto_renew === false && pedido.corpo.domain_name === 'teste-gex.com', JSON.stringify(pedido.corpo));
  ok('a resposta diz o que foi pago e quando vence',
    r.corpo.pagoUsd === 10.44 && r.corpo.renovacaoUsd === 10.44 && r.corpo.expiraEm === '2027-11-05T10:00:00Z');

  let consultas = 0;
  novoCenario((m, c) => {
    if (c.endsWith('/domain-check')) return consulta();
    if (m === 'POST') return fluxo('in_progress');
    consultas += 1;
    return fluxo(consultas < 3 ? 'in_progress' : 'succeeded');
  });
  r = await comprar();
  ok('resposta 202: acompanha o status, sem reenviar a compra',
    r.status === 200 && compras() === 1 && consultas === 3, JSON.stringify(r));

  novoCenario((m, c) => {
    if (c.endsWith('/domain-check')) return consulta();
    return fluxo('in_progress');
  });
  r = await comprar();
  ok('nunca termina: desiste, nao reenvia e manda nao repetir',
    r.status === 502 && compras() === 1 && r.corpo.incerto === true && r.corpo.aviso.includes('NÃO repita'),
    JSON.stringify(r));

  novoCenario((m, c) => {
    if (c.endsWith('/domain-check')) return consulta();
    throw new Error('rede caiu');
  });
  r = await comprar();
  ok('rede cai na compra: resultado incerto, sem reenviar',
    r.status === 502 && compras() === 1 && r.corpo.incerto === true, JSON.stringify(r));

  novoCenario((m, c) => {
    if (c.endsWith('/domain-check')) return consulta();
    return fluxo('action_required', { context: { action: 'Aceite o contrato' } });
  });
  r = await comprar();
  ok('action_required para e mostra o que falta',
    r.status === 502 && compras() === 1 && r.corpo.acao === 'Aceite o contrato', JSON.stringify(r));

  novoCenario((m, c) => {
    if (c.endsWith('/domain-check')) return consulta();
    return { success: false, errors: [{ code: 1000, message: 'Sem forma de pagamento' }] };
  });
  r = await comprar();
  ok('recusa da Cloudflare na compra chega com o motivo',
    r.status === 400 && compras() === 1 && r.corpo.erro.includes('Sem forma de pagamento'), JSON.stringify(r));

  novoCenario(compraNormal);
  const [a, b] = await Promise.all([comprar(), comprar()]);
  ok('dois cliques juntos viram UMA compra', compras() === 1 && [a.status, b.status].sort().join() === '200,400',
    `${a.status} ${b.status} compras=${compras()}`);

  // ── o apontamento ───────────────────────────────────────────────────

  const zona = { id: 'zona-nova', status: 'active', account: { id: 'conta-nova' }, name_servers: ['a.ns', 'b.ns'] };
  const hostnameAtivo = { status: 'active', ssl: { status: 'active' } };
  const cname = { content: SERVIDOR, proxied: false };

  const apontamento = (sobre = {}) => (m, c, corpo) => {
    const achar = sobre.achar ?? {};
    if (m === 'GET' && c.startsWith('/zones?name=')) return { success: true, result: achar.zona ?? [] };
    if (m === 'POST' && c === '/zones') return { success: true, result: { ...zona, status: 'pending', corpo } };
    if (m === 'GET' && c.includes('/custom_hostnames')) return { success: true, result: achar.hostname ?? [] };
    if (m === 'POST' && c.includes('/custom_hostnames')) {
      return sobre.hostnameFalha ?? { success: true, result: { status: 'pending', ssl: { status: 'pending_validation' } } };
    }
    if (m === 'GET' && c.includes('/dns_records')) return { success: true, result: achar.registro ?? [] };
    if (m === 'POST' && c.includes('/dns_records')) return { success: true, result: { content: corpo.content, proxied: corpo.proxied } };
    throw new Error(`chamada inesperada: ${m} ${c}`);
  };
  const apontar = (dominio = 'teste-gex.com') => post('apontar-teste', { dominio });

  novoCenario(apontamento({ achar: { zona: [zona] } }));
  r = await apontar();
  ok('zona ja criada pelo registro: aproveita e diz isso',
    r.status === 200 && r.corpo.zonaVeioPronta === true
    && !chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/zones'), JSON.stringify(r));
  const hostnamePedido = chamadas.find((c) => c.metodo === 'POST' && c.caminho.includes('/custom_hostnames'));
  ok('Custom Hostname nasce na zona principal da CONTA ATUAL',
    hostnamePedido.caminho === '/zones/zona-principal/custom_hostnames'
    && hostnamePedido.corpo.hostname === 'teste-gex.com' && hostnamePedido.corpo.ssl.method === 'http');
  const cnamePedido = chamadas.find((c) => c.metodo === 'POST' && c.caminho.includes('/dns_records'));
  ok('CNAME nasce na zona da CONTA NOVA, apontando para o servidor, sem proxy',
    cnamePedido.caminho === '/zones/zona-nova/dns_records' && cnamePedido.corpo.content === SERVIDOR
    && cnamePedido.corpo.name === '@' && cnamePedido.corpo.proxied === false, JSON.stringify(cnamePedido));
  ok('certificado pendente nao conta como pronto', r.corpo.pronto === false);
  ok('apontar nunca compra', compras() === 0);

  novoCenario(apontamento());
  r = await apontar();
  const zonaPedida = chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/zones');
  ok('sem zona: cria na CONTA NOVA',
    r.status === 200 && r.corpo.zonaVeioPronta === false && zonaPedida?.corpo.account.id === 'conta-nova',
    JSON.stringify(zonaPedida));

  novoCenario(apontamento({ achar: { zona: [{ ...zona, account: { id: 'conta-atual' } }] } }));
  r = await apontar();
  ok('zona em outra conta: recusa e nao mexe em nada',
    r.status === 400 && contar('POST', '/custom_hostnames') === 0 && contar('POST', '/dns_records') === 0,
    JSON.stringify(r));

  novoCenario(apontamento({ achar: { zona: [zona], hostname: [hostnameAtivo], registro: [cname] } }));
  r = await apontar();
  ok('segunda rodada nao cria nada e confirma que ficou pronto',
    r.status === 200 && r.corpo.pronto === true && chamadas.every((c) => c.metodo === 'GET'), JSON.stringify(r));

  novoCenario(apontamento({
    achar: { zona: [zona] },
    hostnameFalha: { success: false, errors: [{ code: 1461, message: 'hostname recusado' }] },
  }));
  r = await apontar();
  ok('falha entre contas diz em qual etapa foi, com o erro da Cloudflare',
    r.status === 502 && r.corpo.etapa === 'criar Custom Hostname' && r.corpo.erro.includes('1461'), JSON.stringify(r));

  novoCenario(apontamento());
  r = await apontar('teste-gex.site');
  ok('apontar tambem so aceita .com', r.status === 400 && chamadas.length === 0);

  await new Promise((resolver) => servidor.close(resolver));

  // ── funções puras ───────────────────────────────────────────────────

  ok('nome e normalizado', nomeCom('  Teste-Gex.COM ') === 'teste-gex.com');
  ok('nome com caminho nao passa', nomeCom('teste.com/x') === null && nomeCom('a.b.com') === null);
  ok('hifen nas pontas nao passa', nomeCom('-teste.com') === null && nomeCom('teste-.com') === null);
  ok('pedido certo passa', motivoParaRecusarPedido('a.com', 'A.com ') === null);
  ok('consulta boa passa', motivoParaRecusarConsulta(
    { configurado: true, ok: true, registravelPorApi: true, tier: 'standard', moeda: 'USD', registroUsd: 10.44 }, 12) === null);
  ok('consulta vazia nao passa', motivoParaRecusarConsulta(undefined, 12) !== null);
  ok('tier desconhecido nao passa', motivoParaRecusarConsulta(
    { configurado: true, ok: true, registravelPorApi: true, tier: null, moeda: 'USD', registroUsd: 10.44 }, 12) !== null);
  ok('resposta indefinida do registro nao quebra', interpretarRegistro(undefined).ok === false);
  ok('estado desconhecido nao conta como terminado', interpretarRegistro(fluxo('pending')).terminou === false);
  ok('erros do certificado aparecem', resumirApontamento(
    zona, { status: 'pending', ssl: { status: 'pending', validation_errors: [{ message: 'caa' }] } }, cname, SERVIDOR,
  ).customHostname.erros[0] === 'caa');

  imprimir('\nPROVAS — REGISTRO DE TESTE DO CLOUDFLARE REGISTRAR\n');
  let falhas = 0;
  for (const p of provas) {
    if (!p.cond) falhas++;
    imprimir(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
  }
  imprimir(`\n${provas.length} provas, ${falhas} falha(s).\n`);
  process.exit(falhas ? 1 : 0);
}

principal().catch((erro) => {
  imprimir(`\nA PROVA QUEBROU: ${erro.stack}\n`);
  process.exit(1);
});
