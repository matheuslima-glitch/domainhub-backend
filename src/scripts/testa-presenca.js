/**
 * PROVAS DO CRUZAMENTO DE PRESENÇA (CLOUDFLARE E WHM)
 *
 *   npm run testa:presenca
 *
 * Exercita `cruzar.js` com listas montadas à mão. Sem rede, sem credencial.
 *
 * O que mais importa aqui é a RECUSA: uma rodada que recebe lista vazia de
 * uma das fontes não pode gravar, porque gravaria "fora" na base inteira e
 * a aba Sem acesso esvaziaria sem ninguém perceber.
 */

// De `cruzar`, nao de `index`: `index` arrasta `config/env`, que lanca sem
// credencial.
const { chave, motivoParaRecusar, cruzar, fatiar } = require('../services/presenca/cruzar');

const provas = [];
const ok = (rot, cond, det) => provas.push({ rot, cond: !!cond, detalhe: det });
const igual = (rot, a, b) =>
  ok(rot, JSON.stringify(a) === JSON.stringify(b), `veio ${JSON.stringify(a)}, esperava ${JSON.stringify(b)}`);

// ── recusa ──────────────────────────────────────────────────────────────

ok('zero zonas na Cloudflare RECUSA a rodada', motivoParaRecusar(0, 500) !== null);
ok('zero contas no WHM RECUSA a rodada', motivoParaRecusar(1000, 0) !== null);
ok('e o motivo diz qual das duas', /WHM/.test(motivoParaRecusar(1000, 0)), motivoParaRecusar(1000, 0));
ok('as duas com conteudo seguem', motivoParaRecusar(1000, 500) === null);

// ── cruzamento ──────────────────────────────────────────────────────────

const dominios = [
  { id: 'a', domain_name: 'nos-dois.com' },
  { id: 'b', domain_name: 'so-cloudflare.com' },
  { id: 'c', domain_name: 'so-whm.com' },
  { id: 'd', domain_name: 'em-nenhum.com' },
  // `domains` tem nomes em caixa mista e com espaco sobrando; Cloudflare e
  // WHM devolvem minusculo. Sem normalizar, este cairia em "nenhum".
  { id: 'e', domain_name: '  Caixa-Mista.COM ' },
  // Dois registros do MESMO dominio (a base tem pares assim). Os dois tem de
  // receber a mesma resposta.
  { id: 'f1', domain_name: 'par.com' },
  { id: 'f2', domain_name: 'PAR.com' },
  { id: 'g', domain_name: null },
];

const zonas = ['nos-dois.com', 'so-cloudflare.com', 'caixa-mista.com', 'par.com'];
const principais = ['nos-dois.com', 'so-whm.com', 'Caixa-Mista.com', 'par.com', '', null];

const { grupos, contagem } = cruzar(dominios, zonas, principais);
const onde = (id) => {
  const g = grupos.find((x) => x.ids.includes(id));
  return g ? `${g.na_cloudflare ? 'cf' : '-'}/${g.no_whm ? 'whm' : '-'}` : 'ausente';
};

igual('nos dois', onde('a'), 'cf/whm');
igual('so na Cloudflare', onde('b'), 'cf/-');
igual('so no WHM', onde('c'), '-/whm');
igual('em nenhum', onde('d'), '-/-');
igual('caixa mista e espaco nao tiram o dominio de lugar nenhum', onde('e'), 'cf/whm');
igual('os dois registros de um par recebem a mesma resposta', [onde('f1'), onde('f2')], ['cf/whm', 'cf/whm']);
igual('nome nulo nao quebra e fica em nenhum', onde('g'), '-/-');

ok(
  'conta do WHM sem dominio nao casa com dominio de nome vazio',
  !grupos.some((g) => g.no_whm && g.ids.includes('g')),
);

igual(
  'todo dominio cai em exatamente um grupo',
  grupos.reduce((s, g) => s + g.ids.length, 0),
  dominios.length,
);
igual('a contagem bate com os grupos', contagem, {
  dominios: 8,
  nosDois: 4,
  soCloudflare: 1,
  soWhm: 1,
  emNenhum: 2,
});

ok('zonas podem vir como iterador (o Map.keys() do coletor)', cruzar(dominios, new Map([['nos-dois.com', 'z']]).keys(), []).contagem.soCloudflare === 1);
ok('base vazia nao quebra', cruzar([], zonas, principais).grupos.length === 0);

// ── fatias ──────────────────────────────────────────────────────────────

igual('fatia em pedacos do tamanho pedido', fatiar([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
igual('lista vazia da zero fatias, nao uma vazia', fatiar([], 200), []);
igual('chave normaliza caixa e espaco', chave('  Exemplo.COM '), 'exemplo.com');

// ── resultado ───────────────────────────────────────────────────────────

console.log('\nPROVAS — CRUZAMENTO DE PRESENÇA (CLOUDFLARE E WHM)\n');
let falhas = 0;
for (const p of provas) {
  if (!p.cond) falhas++;
  console.log(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
}
console.log(`\n${provas.length} provas, ${falhas} falha(s).\n`);
process.exit(falhas ? 1 : 0);
