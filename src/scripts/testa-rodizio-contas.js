/**
 * PROVAS DO RODÍZIO ENTRE AS CONTAS DA NAMECHEAP
 *
 *   npm run testa:rodizio
 *
 * Roda OFFLINE. As credenciais são injetadas por variável de ambiente no
 * começo do arquivo, com valores falsos — `escolher()` é função pura e não
 * toca em rede nem em banco.
 *
 * ── O QUE ESTAS PROVAS PROTEGEM ──────────────────────────────────────────
 *
 * A proporção. Um erro aqui não quebra nada: as compras continuam
 * acontecendo, só que na divisão errada. Ninguém percebe olhando a tela —
 * só contando domínio por conta meses depois.
 *
 * É o tipo de defeito que só um teste pega, porque o sistema continua
 * dizendo que está tudo bem.
 */

process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'falso';
process.env.SUPABASE_USER_ID = 'falso';
process.env.NAMECHEAP_API_USER = 'usuario-principal';
process.env.NAMECHEAP_API_KEY = 'chave-principal';
process.env.NAMECHEAP_CLIENT_IP = '0.0.0.0';
process.env.NAMECHEAP_2_API_USER = 'usuario-paulo';
process.env.NAMECHEAP_2_API_KEY = 'chave-paulo';

const contas = require('../services/namecheap/contas');

const provas = [];
const ok = (rot, cond, det) => provas.push({ rot, cond: !!cond, detalhe: det });

// ── as duas contas existem ──────────────────────────────────────────────

ok('as duas contas sao reconhecidas', contas.listar().length === 2);
ok('e o rodizio liga', contas.temRodizio() === true);
ok(
  'a cota e 2 para a principal e 1 para a nova',
  contas.listar().find((c) => c.apelido === 'principal').cota === 2
    && contas.listar().find((c) => c.apelido === 'paulo').cota === 1,
);

// ── a credencial certa para cada apelido ────────────────────────────────

ok(
  'cada apelido devolve a SUA credencial -- trocar as duas aqui mandaria a '
    + 'compra para a conta errada sem erro nenhum',
  contas.parametros('principal').ApiKey === 'chave-principal'
    && contas.parametros('paulo').ApiKey === 'chave-paulo',
);
ok(
  'UserName acompanha o ApiUser da mesma conta',
  contas.parametros('paulo').UserName === 'usuario-paulo',
);
ok(
  'apelido desconhecido CAI NA PRINCIPAL em vez de lancar -- um dominio '
    + 'gravado com conta que nao existe mais nao pode derrubar a sincronia',
  contas.parametros('inventado').ApiKey === 'chave-principal'
    && contas.parametros('inventado')._apelido === 'principal',
);
ok('nulo tambem cai na principal', contas.parametros(null)._apelido === 'principal');

// ── A PROPORCAO, que e o coracao ────────────────────────────────────────
//
// Simula compras em sequencia, somando no placar a cada escolha.

function simular(n) {
  const placar = { principal: 0, paulo: 0 };
  const ordem = [];
  for (let i = 0; i < n; i++) {
    const escolhida = contas.escolher(placar);
    placar[escolhida]++;
    ordem.push(escolhida === 'principal' ? 'P' : 'p');
  }
  return { placar, ordem: ordem.join('') };
}

const tres = simular(3);
ok(
  'a cada 3 compras: 2 na principal, 1 na nova',
  tres.placar.principal === 2 && tres.placar.paulo === 1,
  JSON.stringify(tres.placar) + ' ordem=' + tres.ordem,
);

const noventa = simular(90);
ok(
  'e em 90 compras a proporcao se mantem exata: 60 e 30',
  noventa.placar.principal === 60 && noventa.placar.paulo === 30,
  JSON.stringify(noventa.placar),
);

ok(
  'a primeira compra vai para a PRINCIPAL -- empate em zero desempata para '
    + 'ela, que e a conta de sempre',
  contas.escolher({ principal: 0, paulo: 0 }) === 'principal',
);
ok(
  'a segunda vai para a nova',
  contas.escolher({ principal: 1, paulo: 0 }) === 'paulo',
);

// AUTOCORRECAO: este e o motivo de a escolha sair da CONTAGEM e nao de um
// contador guardado. Se a compra na conta do Paulo falhar, o placar dela
// nao sobe -- e ela tem de ser escolhida de novo.
ok(
  'FALHA NAO E PULADA: se a compra na nova falhar, o placar dela nao sobe '
    + 'e ela e escolhida outra vez. Um contador guardado avancaria mesmo na '
    + 'falha e o desvio seria permanente',
  contas.escolher({ principal: 1, paulo: 0 }) === 'paulo'
    && contas.escolher({ principal: 1, paulo: 0 }) === 'paulo',
);

ok(
  'placar vazio nao quebra -- e o estado do primeiro dia',
  contas.escolher({}) === 'principal' && contas.escolher() === 'principal',
);
ok(
  'contagem desequilibrada se corrige: muito na principal puxa para a nova',
  contas.escolher({ principal: 100, paulo: 2 }) === 'paulo',
);
ok(
  'e o contrario tambem',
  contas.escolher({ principal: 2, paulo: 100 }) === 'principal',
);

// ── SEM A SEGUNDA CONTA, NADA MUDA ──────────────────────────────────────
//
// O caso que vai valer em producao ate as credenciais do Paulo entrarem no
// Render. Recarrega o modulo sem elas.

delete process.env.NAMECHEAP_2_API_USER;
delete process.env.NAMECHEAP_2_API_KEY;
for (const k of Object.keys(require.cache)) {
  if (k.includes('contas.js') || k.includes('env.js')) delete require.cache[k];
}
const soUma = require('../services/namecheap/contas');

ok('sem a segunda credencial, so a principal existe', soUma.listar().length === 1);
ok('o rodizio desliga', soUma.temRodizio() === false);
ok(
  'TUDO VAI PARA A PRINCIPAL, em qualquer placar -- e o comportamento de '
    + 'hoje, preservado',
  soUma.escolher({ principal: 50, paulo: 0 }) === 'principal'
    && soUma.escolher({}) === 'principal',
);
ok(
  'e pedir a conta do Paulo devolve a credencial da principal, sem lancar',
  soUma.parametros('paulo').ApiKey === 'chave-principal',
);

// ── resultado ───────────────────────────────────────────────────────────

console.log('\nPROVAS — RODIZIO ENTRE AS CONTAS DA NAMECHEAP\n');
let falhas = 0;
for (const p of provas) {
  if (!p.cond) falhas++;
  console.log(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
}
console.log(`\n${provas.length} provas, ${falhas} falha(s).`);
console.log(`Sequencia das 12 primeiras compras: ${simular(12).ordem}   (P = principal, p = paulo)\n`);
process.exit(falhas ? 1 : 0);
