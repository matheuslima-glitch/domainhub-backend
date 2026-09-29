// Exercita a trava de exclusão sem banco e sem rede.
//
// Duas metades:
//
//   1. o SERVIÇO — o que ele responde quando o banco falha, quando a trava
//      não está instalada, quando não há usuário. É aqui que mora a decisão
//      de barrar em vez de liberar, e é o que este teste existe para travar;
//   2. a ROTA — que o 409 sai quando a trava nega, e que o registro só
//      acontece depois de a exclusão dar certo.
//
// Rode com: node src/scripts/testa-trava-exclusao.js
const path = require('path');
const Module = require('module');

const RAIZ = path.join(__dirname, '..', '..');

// config/env.js recusa subir sem estas. Valores falsos bastam: nada aqui sai
// para a rede — o cliente do Supabase é substituído abaixo.
process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.SUPABASE_USER_ID = '00000000-0000-0000-0000-000000000000';
process.env.NAMECHEAP_API_USER = 'fake';
process.env.NAMECHEAP_API_KEY = 'fake';
process.env.NAMECHEAP_CLIENT_IP = '127.0.0.1';

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond, detalhe });

// ── metade 1: o serviço ─────────────────────────────────────────────
// Troco só o createClient, para o resto do arquivo rodar de verdade.
let respostaRpc = { data: { permitido: true, motivo: 'avulso' }, error: null };
let respostaBusca = { data: { id: 'id-real' }, error: null };

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        rpc: async () => respostaRpc,
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => respostaBusca }) }) }),
      }),
    };
  }
  return originalLoad.apply(this, arguments);
};
const servico = require(path.join(RAIZ, 'src/services/exclusao'));
Module._load = originalLoad;

(async () => {
  const base = { domainId: 'abc', domainName: 'exemplo.com', userId: 'usuario-1' };

  respostaRpc = { data: { permitido: true, motivo: 'avulso' }, error: null };
  let r = await servico.verificar(base);
  ok('banco respondeu sim: permite', r.permitido === true, JSON.stringify(r));

  respostaRpc = { data: { permitido: false, motivo: 'ritmo', mensagem: 'x' }, error: null };
  r = await servico.verificar(base);
  ok('banco respondeu nao: barra', r.permitido === false, JSON.stringify(r));

  // O caso que motivou este teste: banco fora tem que BARRAR.
  respostaRpc = { data: null, error: { code: '08006', message: 'connection failure' } };
  r = await servico.verificar(base);
  ok('banco fora: BARRA', r.permitido === false, JSON.stringify(r));
  ok('banco fora: tem mensagem para a tela', !!r.mensagem, JSON.stringify(r.mensagem));

  // Mas "ainda nao instalada" e outra coisa: e o estado esperado entre
  // mesclar o codigo e rodar a migration, e nao pode parar a operacao.
  respostaRpc = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  r = await servico.verificar(base);
  ok('trava nao instalada: permite', r.permitido === true, JSON.stringify(r));
  ok('trava nao instalada: motivo proprio', r.motivo === 'trava_nao_instalada', r.motivo);

  respostaRpc = { data: null, error: { code: '42883', message: 'function does not exist' } };
  r = await servico.verificar(base);
  ok('funcao ausente pelo codigo do Postgres: permite', r.permitido === true, JSON.stringify(r));

  respostaRpc = { data: { permitido: true, motivo: 'avulso' }, error: null };
  r = await servico.verificar({ ...base, userId: null });
  ok('sem usuario: BARRA', r.permitido === false, JSON.stringify(r));

  respostaBusca = { data: null, error: null };
  r = await servico.verificar({ domainName: 'fantasma.com', userId: 'usuario-1' });
  ok('dominio fora da base: BARRA', r.permitido === false, JSON.stringify(r));
  respostaBusca = { data: { id: 'id-real' }, error: null };

  // A chave de emergencia passa por cima de tudo.
  respostaRpc = { data: null, error: { code: '08006', message: 'connection failure' } };
  require(path.join(RAIZ, 'src/config/env')).EXCLUSAO_EXIGE_APROVACAO = false;
  r = await servico.verificar(base);
  ok('trava desligada: permite mesmo com banco fora', r.permitido === true, JSON.stringify(r));
  require(path.join(RAIZ, 'src/config/env')).EXCLUSAO_EXIGE_APROVACAO = true;

  // ── metade 2: a rota ──────────────────────────────────────────────
  const chamadas = { verificar: [], registrar: [] };
  let respostaDaTrava = { permitido: true, motivo: 'avulso' };
  let resultadoDaExclusao = { overallSuccess: true };

  Module._load = function (pedido) {
    if (pedido.includes('services/exclusao')) {
      return {
        async verificar(args) { chamadas.verificar.push(args); return respostaDaTrava; },
        async registrar(args) { chamadas.registrar.push(args); },
        async avisarDiscord() {},
        async idDoDominio() { return 'id-fake'; },
      };
    }
    if (pedido.includes('services/domain-deactivation')) {
      return class { async deactivateDomain() { return resultadoDaExclusao; } };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(RAIZ, 'src/routes/domain-deactivation'))];
  const router = require(path.join(RAIZ, 'src/routes/domain-deactivation'));
  Module._load = originalLoad;

  const camada = router.stack.find((c) => c.route && c.route.path === '/execute' && c.route.methods.post);
  if (!camada) { console.error('❌ nao achei a rota /execute'); process.exit(1); }
  const handler = camada.route.stack[0].handle;

  const resposta = () => {
    const x = { code: 200, body: null };
    x.status = (c) => { x.code = c; return x; };
    x.json = (b) => { x.body = b; return x; };
    return x;
  };
  const req = { body: { domainId: 'abc', domainName: 'exemplo.com' }, user: { id: 'usuario-1' } };

  respostaDaTrava = { permitido: true, motivo: 'avulso' };
  resultadoDaExclusao = { overallSuccess: true };
  chamadas.verificar = []; chamadas.registrar = [];
  let res = resposta();
  await handler(req, res);
  ok('rota, permitido: responde 200', res.code === 200, 'code=' + res.code);
  ok('rota, permitido: registra', chamadas.registrar.length === 1, chamadas.registrar.length + '');
  ok('rota: passa o usuario para a trava', chamadas.verificar[0].userId === 'usuario-1', JSON.stringify(chamadas.verificar[0]));

  respostaDaTrava = { permitido: false, motivo: 'ritmo', mensagem: 'passou do ritmo' };
  chamadas.verificar = []; chamadas.registrar = [];
  res = resposta();
  await handler(req, res);
  ok('rota, negado: responde 409', res.code === 409, 'code=' + res.code);
  ok('rota, negado: marca bloqueado', res.body && res.body.bloqueado === true, JSON.stringify(res.body));
  ok('rota, negado: repassa a mensagem', res.body && res.body.message === 'passou do ritmo', JSON.stringify(res.body && res.body.message));
  ok('rota, negado: NAO registra', chamadas.registrar.length === 0, chamadas.registrar.length + '');

  respostaDaTrava = { permitido: true, motivo: 'avulso' };
  resultadoDaExclusao = { overallSuccess: false };
  chamadas.registrar = [];
  res = resposta();
  await handler(req, res);
  ok('rota, exclusao falhou: NAO registra', chamadas.registrar.length === 0, chamadas.registrar.length + '');

  let falhas = 0;
  console.log('\nTRAVA DE EXCLUSAO\n');
  provas.forEach((p) => {
    if (!p.cond) falhas++;
    console.log('  ' + (p.cond ? 'ok ' : '❌ ') + p.rot.padEnd(48) + (p.cond ? '' : p.detalhe));
  });
  console.log('\n' + provas.length + ' conferencias, ' + falhas + ' falhas.');
  process.exit(falhas ? 1 : 0);
})();
