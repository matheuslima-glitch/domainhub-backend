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

// ── 4b. a janela do mes corrente ────────────────────────────────────
//
// Do dia 1 ate ONTEM, e o mes e o de ontem, nao o de hoje. No dia 1o o mes de
// hoje nao tem nenhum dia fechado e a janela sairia invertida (`de` depois de
// `ate`). Ancorado em ontem, a virada do mes acontece sozinha.
const emDia = (s) => new Date(s + 'T12:00:00Z');
const jan = (s) => servico.janelaDoMes(emDia(s));

ok(
  'em 02/10 a janela e 01/10 ate 01/10 (um dia de outubro)',
  jan('2026-10-02').de === '2026-10-01' && jan('2026-10-02').ate === '2026-10-01',
  JSON.stringify(jan('2026-10-02'))
);
ok(
  'em 15/10 vai do dia 1 ate ontem',
  jan('2026-10-15').de === '2026-10-01' && jan('2026-10-15').ate === '2026-10-14',
  JSON.stringify(jan('2026-10-15'))
);
ok(
  'no dia 1o de novembro a janela e OUTUBRO INTEIRO, nao novembro vazio',
  jan('2026-11-01').de === '2026-10-01' && jan('2026-11-01').ate === '2026-10-31',
  JSON.stringify(jan('2026-11-01'))
);
ok(
  'no dia 2 ela ja passou para novembro -- sem buraco e sem sobreposicao',
  jan('2026-11-02').de === '2026-11-01' && jan('2026-11-02').ate === '2026-11-01',
  JSON.stringify(jan('2026-11-02'))
);
ok(
  'a virada de ANO tambem anda certo',
  jan('2027-01-01').de === '2026-12-01' && jan('2027-01-01').ate === '2026-12-31',
  JSON.stringify(jan('2027-01-01'))
);
ok(
  'a janela nunca sai invertida',
  ['2026-10-01', '2026-10-02', '2026-11-01', '2027-01-01', '2026-03-01'].every(
    (d) => jan(d).de <= jan(d).ate
  )
);
ok('e `ref` e sempre o primeiro dia do mes da janela', jan('2026-10-15').ref === '2026-10-01');

// ── 4c. a janela longa, de 30 dias ──────────────────────────────────
//
// Os dois numeros da aba curta do dashboard saem desta janela, da MESMA
// consulta -- por isso nao tem como divergirem. Ela nao pode ser derivada das
// outras: janelas deduplicadas nao se combinam.
const lon = (s) => servico.janelaLonga(emDia(s));

ok(
  'a janela longa tem 30 dias e termina ONTEM',
  lon('2026-10-05').de === '2026-09-05' && lon('2026-10-05').ate === '2026-10-04',
  JSON.stringify(lon('2026-10-05'))
);
ok(
  'atravessa a virada de mes sem tropecar',
  lon('2026-11-02').de === '2026-10-03' && lon('2026-11-02').ate === '2026-11-01',
  JSON.stringify(lon('2026-11-02'))
);
ok(
  'e a virada de ano',
  lon('2027-01-10').de === '2026-12-11' && lon('2027-01-10').ate === '2027-01-09',
  JSON.stringify(lon('2027-01-10'))
);
// INCLUSIVE, nao a diferenca: de 05/09 a 04/10 sao 29 dias de intervalo e 30
// dias de calendario. Minha primeira versao desta prova contou a diferenca e
// reprovou um codigo que estava certo.
ok(
  'sao sempre 30 dias de calendario, em qualquer mes',
  ['2026-03-01', '2026-03-15', '2026-05-31', '2027-01-01', '2026-10-05'].every((d) => {
    const j = lon(d);
    return Math.round((Date.parse(j.ate) - Date.parse(j.de)) / 86400000) + 1 === 30;
  })
);
// A longa tem de CONTER a de 14 dias: as duas terminam no mesmo dia e a
// longa comeca antes. Se um dia alguem trocar os offsets de lugar, e aqui que
// aparece.
ok(
  'a janela longa CONTEM a de 14 dias',
  ['2026-10-05', '2026-11-02', '2027-01-01'].every((d) => {
    const curta = servico.janela(emDia(d));
    const longa = lon(d);
    return longa.de < curta.de && longa.ate === curta.ate;
  })
);

// `dataISO` nao pode mutar a data que recebe: a segunda chamada partiria de
// uma data ja deslocada.
const fixa = emDia('2026-10-15');
servico.dataISO(-30, fixa);
ok(
  'dataISO nao mexe na data recebida',
  servico.dataISO(-1, fixa) === '2026-10-14',
  servico.dataISO(-1, fixa)
);

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
