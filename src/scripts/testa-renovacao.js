/**
 * PROVAS DA LEITURA DA RESPOSTA DE RENOVAÇÃO
 *
 *   npm run testa:renovacao
 *
 * Offline: `renovacao-resposta.js` não importa nada.
 *
 * ── POR QUE ESTAS PROVAS SÃO AS MAIS IMPORTANTES DO PROJETO ──────────────
 *
 * Porque renovação GASTA DINHEIRO e não tem desfazer. Em todo o resto do
 * sistema, ler errado produz uma tela errada. Aqui, ler errado produz uma
 * das duas coisas:
 *
 *   achar que renovou quando não renovou  -> o domínio expira, e o
 *                                            histórico diz que está pago
 *   achar que falhou quando renovou       -> alguém renova de novo, e
 *                                            paga duas vezes
 *
 * A armadilha concreta: a Namecheap responde HTTP 200 com o erro DENTRO do
 * XML. Quem testar só o código HTTP conclui que cobrou quando não cobrou.
 */

const { lerRenovacao } = require('../services/namecheap/renovacao-resposta');

const provas = [];
const ok = (rot, cond, det) => provas.push({ rot, cond: !!cond, detalhe: det });

// ── o caso bom ──────────────────────────────────────────────────────────

const BOM = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.renew">
    <DomainRenewResult DomainName="exemplo.site" DomainID="123456" Renew="true"
      ChargedAmount="30.1800" OrderID="98765" TransactionID="54321" />
  </CommandResponse>
</ApiResponse>`;

let r = lerRenovacao(BOM);
ok('le a renovacao bem-sucedida', r.ok === true);
ok(
  'CONVERTE ChargedAmount para numero -- a Namecheap manda "30.1800" com '
    + 'quatro casas, e isso vai direto para a contabilidade',
  r.cobradoUsd === 30.18 && typeof r.cobradoUsd === 'number',
  `${typeof r.cobradoUsd} ${r.cobradoUsd}`,
);
ok('traz OrderID e TransactionID', r.orderId === '98765' && r.transactionId === '54321');

// ── A ARMADILHA: HTTP 200 com erro dentro ───────────────────────────────

const ERRO_DENTRO = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR">
  <Errors><Error Number="2528166">Order creation failed</Error></Errors>
</ApiResponse>`;

r = lerRenovacao(ERRO_DENTRO);
ok(
  'ERRO DENTRO DO XML e detectado -- a Namecheap responde HTTP 200 nestes '
    + 'casos, entao quem testar so o codigo HTTP acha que cobrou',
  r.ok === false && r.erro.includes('2528166'),
  r.erro,
);

const SALDO = `<ApiResponse Status="ERROR"><Errors>
  <Error Number="2511170">Insufficient account balance</Error></Errors></ApiResponse>`;
r = lerRenovacao(SALDO);
ok(
  'saldo insuficiente chega com numero e mensagem -- e o erro mais provavel '
    + 'no meio de um lote',
  r.ok === false && r.erro.includes('2511170') && r.erro.includes('Insufficient'),
  r.erro,
);

// ── Renew="false": pediu, nao deu erro, e NAO renovou ───────────────────

const NEGADO = `<ApiResponse Status="OK"><CommandResponse>
  <DomainRenewResult DomainName="x.site" Renew="false" ChargedAmount="0" /></CommandResponse></ApiResponse>`;
r = lerRenovacao(NEGADO);
ok(
  'Renew="false" NAO conta como sucesso, mesmo sem bloco de erro -- e o '
    + 'caso que faria o sistema registrar renovacao que nao aconteceu',
  r.ok === false,
  JSON.stringify(r),
);

// ── degenerados ─────────────────────────────────────────────────────────

ok(
  'resposta sem DomainRenewResult nao vira sucesso',
  lerRenovacao('<ApiResponse Status="OK"></ApiResponse>').ok === false,
);
ok('resposta vazia nao quebra', lerRenovacao('').ok === false);
ok('resposta nula nao quebra', lerRenovacao(null).ok === false);

const SEM_VALOR = `<ApiResponse Status="OK"><CommandResponse>
  <DomainRenewResult DomainName="x.site" Renew="true" OrderID="1" /></CommandResponse></ApiResponse>`;
r = lerRenovacao(SEM_VALOR);
ok(
  'sem ChargedAmount o valor e NULO, nao zero -- zero diria "renovou de '
    + 'graca", que e afirmacao sobre dinheiro que ninguem verificou',
  r.ok === true && r.cobradoUsd === null,
  String(r.cobradoUsd),
);

ok(
  'Renew="TRUE" em maiuscula tambem conta -- o valor vem da API deles e '
    + 'nao controlamos a caixa',
  lerRenovacao(BOM.replace('Renew="true"', 'Renew="TRUE"')).ok === true,
);

// ── resultado ───────────────────────────────────────────────────────────

console.log('\nPROVAS — LEITURA DA RESPOSTA DE RENOVACAO\n');
let falhas = 0;
for (const p of provas) {
  if (!p.cond) falhas++;
  console.log(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
}
console.log(`\n${provas.length} provas, ${falhas} falha(s).\n`);
process.exit(falhas ? 1 : 0);
