// Exercita a lógica da trava sem banco e sem rede.
//
// O que isto prova: que `podeSeguir` barra com 409 quando a trava nega, que
// deixa passar quando permite, e que o registro só acontece depois de a
// exclusão dar certo. Não prova as regras em si — elas estão no Postgres.
const path = require('path');
const Module = require('module');

const RAIZ = path.join(__dirname, '..', '..');

// Intercepta os require pesados antes de carregar a rota: sem isto ela abriria
// conexão com o Supabase só para ser lida.
const originalLoad = Module._load;
const chamadas = { verificar: [], registrar: [] };
let respostaDaTrava = { permitido: true, motivo: 'avulso' };
let resultadoDaExclusao = { overallSuccess: true };

Module._load = function (pedido, pai, isMain) {
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

process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.SUPABASE_USER_ID = '00000000-0000-0000-0000-000000000000';

const router = require(path.join(RAIZ, 'src/routes/domain-deactivation'));
Module._load = originalLoad;

// Acha o handler de POST /execute dentro da pilha do express.
const camada = router.stack.find((c) => c.route && c.route.path === '/execute' && c.route.methods.post);
if (!camada) { console.error('❌ nao achei a rota /execute'); process.exit(1); }
const handler = camada.route.stack[0].handle;

function resposta() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond, detalhe });

(async () => {
  const req = {
    body: { domainId: 'abc', domainName: 'exemplo.com' },
    user: { id: 'usuario-1' },
  };

  // 1. trava permite -> exclusao roda e é registrada
  respostaDaTrava = { permitido: true, motivo: 'avulso' };
  resultadoDaExclusao = { overallSuccess: true };
  chamadas.verificar = []; chamadas.registrar = [];
  let res = resposta();
  await handler(req, res);
  ok('permitido: responde 200', res.code === 200, 'code=' + res.code);
  ok('permitido: registra a exclusao', chamadas.registrar.length === 1, chamadas.registrar.length + ' registros');
  ok('permitido: passa o usuario para a trava', chamadas.verificar[0].userId === 'usuario-1', JSON.stringify(chamadas.verificar[0]));

  // 2. trava nega -> 409, nada roda, nada é registrado
  respostaDaTrava = { permitido: false, motivo: 'ritmo', mensagem: 'passou do ritmo' };
  chamadas.verificar = []; chamadas.registrar = [];
  res = resposta();
  await handler(req, res);
  ok('negado: responde 409', res.code === 409, 'code=' + res.code);
  ok('negado: marca bloqueado', res.body && res.body.bloqueado === true, JSON.stringify(res.body));
  ok('negado: repassa a mensagem', res.body && res.body.message === 'passou do ritmo', JSON.stringify(res.body && res.body.message));
  ok('negado: NAO registra exclusao', chamadas.registrar.length === 0, chamadas.registrar.length + ' registros');

  // 3. trava permite mas a exclusao falha -> nao registra
  //    Importante: exclusao que morreu no meio nao pode contar para o ritmo.
  respostaDaTrava = { permitido: true, motivo: 'avulso' };
  resultadoDaExclusao = { overallSuccess: false };
  chamadas.verificar = []; chamadas.registrar = [];
  res = resposta();
  await handler(req, res);
  ok('exclusao falhou: NAO registra', chamadas.registrar.length === 0, chamadas.registrar.length + ' registros');

  let falhas = 0;
  console.log('TRAVA DE EXCLUSAO — caminho do /execute\n');
  provas.forEach((p) => {
    if (!p.cond) falhas++;
    console.log('  ' + (p.cond ? 'ok ' : '❌ ') + p.rot.padEnd(44) + (p.cond ? '' : p.detalhe));
  });
  console.log('\n' + provas.length + ' conferencias, ' + falhas + ' falhas.');
  process.exit(falhas ? 1 : 0);
})();
