/**
 * PROVAS DA LEITURA DA RESPOSTA DO CLOUDFLARE REGISTRAR
 *
 *   npm run testa:registrar
 *
 * Exercita `interpretar()` contra o formato documentado em
 * developers.cloudflare.com/api/resources/registrar/methods/check.
 * Sem rede, sem credencial.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────
 *
 * Porque a primeira versão deste parser supôs QUATRO nomes de campo e
 * acertou zero:
 *
 *   enviava `domain_names`      era `domains`
 *   lia `result`                era `result.domains`
 *   lia `available`             era `registrable`
 *   lia `price` / `fees`        era `pricing.registration_cost`, em STRING
 *
 * O sintoma foi enganoso: a Cloudflare respondeu
 * `1006: domains array must contain at least one domain`, que soa como
 * "lista vazia" e não como "nome de campo errado".
 *
 * A API está em BETA. Quando o formato mudar, estas provas quebram aqui e
 * não na primeira compra de verdade.
 */

// De `registrar-resposta`, nao de `registrar`: o parser mora separado
// justamente para este arquivo nao arrastar `config/env`, que lanca sem
// credencial. Terceira vez que isso morde no projeto.
const { interpretar } = require('../services/cloudflare/registrar-resposta');

const provas = [];
const ok = (rot, cond, det) => provas.push({ rot, cond: !!cond, detalhe: det });

const TETO = 5;

// ── o caso bom, no formato EXATO da documentacao ────────────────────────

const BOM = {
  success: true,
  errors: [],
  result: {
    domains: [
      {
        name: 'zxqk-teste-8821.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.44', renewal_cost: '10.44' },
      },
    ],
  },
};

let r = interpretar(BOM, 'zxqk-teste-8821.com', TETO);

ok('le result.domains, nao result direto', r.ok === true && r.dominio === 'zxqk-teste-8821.com');
ok('le `registrable`, nao `available`', r.registravelPorApi === true, String(r.registravelPorApi));
ok(
  'CONVERTE OS PRECOS: a API devolve STRING, entregamos NUMERO',
  r.registroUsd === 10.44 && typeof r.registroUsd === 'number',
  `${typeof r.registroUsd} ${r.registroUsd}`,
);
ok('traz registro E renovacao na mesma consulta', r.renovacaoUsd === 10.44);
ok('le a moeda e o tier', r.moeda === 'USD' && r.tier === 'standard');
ok(
  'COMPARA COM O TETO do fluxo de compra -- .com a 10,44 NAO passa em 5,00. '
    + 'Se o .com for para a compra automatica, o teto tem de virar por terminacao',
  r.passaNoTeto === false && r.tetoDaCompraPorIA === 5,
  `teto=${r.tetoDaCompraPorIA} passa=${r.passaNoTeto}`,
);

const barato = JSON.parse(JSON.stringify(BOM));
barato.result.domains[0].pricing.registration_cost = '1.18';
ok('e um nome barato passa', interpretar(barato, 'zxqk-teste-8821.com', TETO).passaNoTeto === true);

ok(
  'escolhe pelo NOME, nao pelo primeiro -- a resposta pode omitir nomes '
    + 'malformados e trazer a lista fora de ordem',
  interpretar(
    { success: true, result: { domains: [
      { name: 'outro.com', registrable: false, reason: 'domain_unavailable' },
      { name: 'certo.com', registrable: true, tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '2.00', renewal_cost: '9.00' } },
    ] } },
    'certo.com', TETO,
  ).registroUsd === 2,
);

// ── os motivos levam a conclusoes OPOSTAS ───────────────────────────────

for (const motivo of ['domain_unavailable', 'extension_not_supported_via_api', 'domain_premium']) {
  const res = interpretar(
    { success: true, result: { domains: [{ name: 'x.com', registrable: false, reason: motivo }] } },
    'x.com', TETO,
  );
  ok(`motivo "${motivo}" chega inteiro a quem le`, res.motivo === motivo && res.registravelPorApi === false);
  ok(
    `e sem pricing o preco e NULO, nao zero ("${motivo}")`,
    res.registroUsd === null && res.passaNoTeto === null,
    `${res.registroUsd} / ${res.passaNoTeto}`,
  );
}

// ── degenerados ─────────────────────────────────────────────────────────

ok(
  'lista vazia nao quebra e nao inventa',
  (() => { const x = interpretar({ success: true, result: { domains: [] } }, 'x.com', TETO);
    return x.ok === true && x.registravelPorApi === null && x.registroUsd === null; })(),
);
ok(
  'result nulo nao quebra',
  interpretar({ success: true, result: null }, 'x.com', TETO).registravelPorApi === null,
);
ok(
  'erro da Cloudflare chega com codigo E mensagem -- 9109 e token sem a '
    + 'permissao de Registrar, e quem le precisa saber disso',
  (() => { const x = interpretar(
    { success: false, errors: [{ code: 9109, message: 'Unauthorized' }], result: null }, 'x.com', TETO);
    return x.ok === false && x.erro.includes('9109') && x.erro.includes('Unauthorized'); })(),
);
ok(
  'resposta sem sucesso e sem erro declarado ainda diz alguma coisa',
  interpretar({ success: false }, 'x.com', TETO).erro.length > 10,
);
ok('resposta indefinida nao quebra', interpretar(undefined, 'x.com', TETO).ok === false);

// ── resultado ───────────────────────────────────────────────────────────

console.log('\nPROVAS — LEITURA DA RESPOSTA DO CLOUDFLARE REGISTRAR\n');
let falhas = 0;
for (const p of provas) {
  if (!p.cond) falhas++;
  console.log(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
}
console.log(`\n${provas.length} provas, ${falhas} falha(s).\n`);
process.exit(falhas ? 1 : 0);
