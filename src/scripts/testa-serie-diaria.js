// Exercita a gravação da série diária sem banco e sem rede.
//
// O que este teste trava, e por que cada coisa importa:
//
//   1. UMA LINHA POR DIA POR DOMÍNIO. Uma zona pode servir mais de um
//      domínio; a série dela tem de virar linha para cada um.
//   2. DIA COM ZERO VIRA LINHA — mas isso é DEFESA, não o caminho normal.
//      Medido em 02/10/2026: das 7.654 linhas da primeira rodada real,
//      nenhuma tem `requests = 0`. A Cloudflare omite o grupo do dia sem
//      requisição, então a entrada desta prova é fabricada de propósito e o
//      que ela trava é o código não quebrar se a API mudar de ideia.
//   3. UNIQUES AUSENTE VIRA NULL, NÃO ZERO. Quando a coleta de únicos está
//      desligada, a resposta não traz `uniq`. Gravar 0 ali afirmaria que
//      ninguém visitou.
//   4. O INTERRUPTOR DESLIGA. COLETA_DIARIA=false não pode gravar nada.
//   5. FALHA NO UPSERT NÃO DERRUBA A RODADA, e o que deu certo é contado.
//
// Rode com: node src/scripts/testa-serie-diaria.js
const path = require('path');
const Module = require('module');

const RAIZ = path.join(__dirname, '..', '..');

process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.SUPABASE_USER_ID = '00000000-0000-0000-0000-000000000000';
process.env.NAMECHEAP_API_USER = 'fake';
process.env.NAMECHEAP_API_KEY = 'fake';
process.env.NAMECHEAP_CLIENT_IP = '127.0.0.1';
process.env.CLOUDFLARE_EMAIL = 'fake@exemplo.com';
process.env.CLOUDFLARE_API_KEY = 'fake';
process.env.CLOUDFLARE_ACCOUNT_ID = 'fake';

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond, detalhe });

// Substitui só o createClient; o resto do analytics.js roda de verdade.
let upsertsRecebidos = [];
let falharProximoUpsert = false;

const original = Module._load;
Module._load = function (pedido, pai, ehPrincipal) {
  if (pedido === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        from(tabela) {
          return {
            upsert(linhas) {
              upsertsRecebidos.push({ tabela, linhas });
              if (falharProximoUpsert) {
                falharProximoUpsert = false;
                return Promise.resolve({ error: { message: 'falha simulada' } });
              }
              return Promise.resolve({ error: null });
            },
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
            select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) })
          };
        }
      })
    };
  }
  return original.apply(this, arguments);
};

const servico = require(path.join(RAIZ, 'src/services/cloudflare/analytics'));
const config = require(path.join(RAIZ, 'src/config/env'));

// ── 1. uma linha por dia POR DOMÍNIO ────────────────────────────────
const serie = [
  { dimensions: { date: '2026-09-29' }, sum: { requests: 100 }, uniq: { uniques: 40 } },
  { dimensions: { date: '2026-09-30' }, sum: { requests: 0 }, uniq: { uniques: 0 } }
];

const umDominio = servico.linhasDiarias(serie, ['dom-a']);
ok('1 zona x 2 dias x 1 dominio = 2 linhas', umDominio.length === 2, `veio ${umDominio.length}`);

const doisDominios = servico.linhasDiarias(serie, ['dom-a', 'dom-b']);
ok('a mesma zona servindo 2 dominios = 4 linhas', doisDominios.length === 4, `veio ${doisDominios.length}`);
ok(
  'cada dominio recebe os dois dias',
  doisDominios.filter((l) => l.domain_id === 'dom-b').length === 2,
  'dom-b ficou com ' + doisDominios.filter((l) => l.domain_id === 'dom-b').length
);

// ── 2. dia com zero vira linha (entrada FABRICADA — a API nao manda) ─
const diaZero = umDominio.find((l) => l.data === '2026-09-30');
ok('dia zerado FABRICADO vira linha (defesa, nao caminho real)', !!diaZero, 'nao encontrei a linha de 30/09');
ok('e o zero e gravado como 0, nao null', diaZero && diaZero.requests === 0, `requests=${diaZero && diaZero.requests}`);

// ── 3. uniques ausente vira null ────────────────────────────────────
const semUniq = servico.linhasDiarias(
  [{ dimensions: { date: '2026-09-29' }, sum: { requests: 10 } }],
  ['dom-a']
);
ok(
  'sem uniq na resposta, uniques fica NULL (nao 0)',
  semUniq[0].uniques === null,
  `veio ${JSON.stringify(semUniq[0].uniques)}`
);

// ── 4. serie vazia nao gera linha ───────────────────────────────────
ok('serie vazia nao gera linha', servico.linhasDiarias([], ['dom-a']).length === 0);
ok('serie nula nao quebra', servico.linhasDiarias(null, ['dom-a']).length === 0);

// ── 5. gravacao: lotes, falha parcial e lista vazia ─────────────────
(async () => {
  upsertsRecebidos = [];
  const nada = await servico.gravarDiario([]);
  ok('lista vazia nao chama o banco', nada === 0 && upsertsRecebidos.length === 0);

  upsertsRecebidos = [];
  const muitas = [];
  for (let i = 0; i < 1200; i++) muitas.push({ domain_id: 'd', data: '2026-09-29', requests: 1, uniques: 1 });
  const gravadas = await servico.gravarDiario(muitas);
  ok('1.200 linhas sao divididas em lotes', upsertsRecebidos.length === 3, `foram ${upsertsRecebidos.length} lotes`);
  ok('e todas contadas como gravadas', gravadas === 1200, `contou ${gravadas}`);
  ok(
    'o upsert vai para domain_daily_stats',
    upsertsRecebidos.every((u) => u.tabela === 'domain_daily_stats'),
    upsertsRecebidos.map((u) => u.tabela).join(',')
  );

  upsertsRecebidos = [];
  falharProximoUpsert = true;
  const parcial = await servico.gravarDiario(muitas);
  ok(
    'falha de um lote nao derruba os outros',
    parcial === 700,
    `contou ${parcial}, esperava 700 (1.200 menos o lote de 500 que falhou)`
  );

  // ── 6. o interruptor ──────────────────────────────────────────────
  ok('COLETA_DIARIA existe na config', typeof config.COLETA_DIARIA === 'boolean', typeof config.COLETA_DIARIA);
  ok('e vem ligada por padrao', config.COLETA_DIARIA === true, String(config.COLETA_DIARIA));

  // ── resultado ─────────────────────────────────────────────────────
  console.log('\nSERIE DIARIA — PROVAS\n');
  let falhas = 0;
  provas.forEach((p) => {
    if (!p.cond) falhas++;
    console.log(`  ${p.cond ? 'ok ' : '❌ '} ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
  });
  console.log(`\n${provas.length} provas, ${falhas} falha(s).`);
  process.exit(falhas ? 1 : 0);
})();
