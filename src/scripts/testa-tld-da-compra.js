/**
 * PROVAS DA TERMINAÇÃO DA COMPRA POR IA
 *
 *   npm run testa:tld
 *
 * Roda OFFLINE: `../purchase-domains/tld` não importa `config`, então não
 * precisa de credencial nem de rede.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────
 *
 * A expressão regular de formato é montada por concatenação, e o ponto
 * PRECISA ser escapado. Sem o escape ele vira curinga e `exemplosite` —
 * sem ponto nenhum — passa como se fosse `exemplo.site`.
 *
 * Eu escorreguei exatamente nisso ao escrever a troca: a primeira versão
 * gerava `/^[a-z0-9]+.site$/` e aceitava domínio sem ponto. O defeito não
 * aparece em leitura casual, porque a linha parece certa — só aparece
 * testando a expressão contra um caso errado.
 *
 * O dano seria caro e silencioso: um nome sem ponto chega à Namecheap, a
 * compra falha ou registra coisa errada, e o log culpa a disponibilidade.
 */

const { TLD, SUFIXO, FORMATO, DENTRO_DO_TEXTO } = require('../purchase-domains/tld');

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond: !!cond, detalhe });

// ── a constante ─────────────────────────────────────────────────────────

ok('a terminacao e `site`', TLD === 'site', TLD);
ok('o sufixo tem o ponto', SUFIXO === '.site', SUFIXO);
ok('e o sufixo deriva do TLD, nao e digitado de novo', SUFIXO === '.' + TLD);

// ── o formato, que e onde o escape importa ──────────────────────────────

ok('aceita o caso bom', FORMATO.test('exemplo.site'));
ok('aceita numeros no nome', FORMATO.test('saude360.site'));

ok(
  'O PONTO E ESCAPADO: `exemplosite` SEM PONTO tem de ser REJEITADO. Se esta '
    + 'prova falhar, a expressao virou /^[a-z0-9]+.site$/ e o ponto e curinga',
  !FORMATO.test('exemplosite'),
  String(FORMATO),
);
ok(
  'e qualquer caractere no lugar do ponto tambem e rejeitado',
  !FORMATO.test('exemploXsite') && !FORMATO.test('exemplo-site'),
);

ok('rejeita a terminacao antiga', !FORMATO.test('exemplo.online'));
ok('rejeita outra terminacao qualquer', !FORMATO.test('exemplo.com'));
ok(
  'rejeita hifen e acento no nome -- e a regra que o prompt pede e esta '
    + 'linha faz valer',
  !FORMATO.test('exem-plo.site') && !FORMATO.test('saúde.site'),
);
ok('rejeita subdominio', !FORMATO.test('blog.exemplo.site'));
ok('rejeita nome vazio', !FORMATO.test('.site'));
ok('rejeita maiuscula -- o fluxo baixa a caixa antes de validar', !FORMATO.test('Exemplo.site'));

// ── a rede para resposta fora do JSON ───────────────────────────────────

ok(
  'acha o dominio no meio de texto solto',
  'Claro! Sugiro vidasaudavel.site para o seu nicho.'.match(DENTRO_DO_TEXTO)?.[0]
    === 'vidasaudavel.site',
  String('Claro! Sugiro vidasaudavel.site para o seu nicho.'.match(DENTRO_DO_TEXTO)?.[0]),
);
ok(
  'e aqui o ponto tambem e escapado',
  !'textosemponto vidasaudavelsite fim'.match(DENTRO_DO_TEXTO),
);
ok(
  'nao confunde com a terminacao antiga',
  !'Sugiro vidasaudavel.online'.match(DENTRO_DO_TEXTO),
);

// ── resultado ───────────────────────────────────────────────────────────

console.log('\nPROVAS — TERMINACAO DA COMPRA POR IA\n');
let falhas = 0;
for (const p of provas) {
  if (!p.cond) falhas++;
  console.log(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
}
console.log(`\n${provas.length} provas, ${falhas} falha(s).`);
console.log(`Terminacao: ${SUFIXO}   Formato: ${FORMATO}\n`);
process.exit(falhas ? 1 : 0);
