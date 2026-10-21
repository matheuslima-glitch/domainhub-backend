/**
 * PROVAS DO LEITOR DE PREÇOS DA NAMECHEAP
 *
 *   node src/scripts/testa-precos-renovacao.js
 *
 * Roda OFFLINE, contra um XML de exemplo no formato real da Namecheap.
 * Não chama a API, não precisa de credencial, não escreve no banco — dá
 * para rodar em qualquer máquina.
 *
 * Por que offline: o que quebra num leitor de XML é o formato, não a rede.
 * Depender da API para provar isso transformaria "o parser está certo" em
 * "a Namecheap respondeu hoje", que é outra pergunta.
 *
 * Para ver o catálogo DE VERDADE, com credencial e IP na whitelist:
 *
 *   node -e "require('./src/services/namecheap/pricing').sincronizar()"
 */

// De `pricing-xml`, não de `pricing`: o leitor mora separado justamente
// para este arquivo não arrastar `config/env`, que lança sem credencial.
const { lerPrecos } = require('../services/namecheap/pricing-xml');

// ── o XML ───────────────────────────────────────────────────────────────
//
// Copiado da forma que a Namecheap devolve, com os casos que importam:
//
//   com       o caso comum, com taxa ICANN
//   co.uk     ccTLD: sem ICANN, e o nome tem ponto no meio
//   online    taxa ICANN diferente, para a soma não passar por acaso
//   grafia    a Namecheap consertando o typo "Additonal" -> "Additional"
//   soDois    só vende a partir de 2 anos — tem de ficar DE FORA
//   emMeses   duração em mês, não ano — tem de ficar DE FORA
//   semPreco  sem YourPrice — tem de ficar DE FORA, não virar zero
//
// O bloco "register" no fim existe para provar que o leitor não o confunde
// com "renew": são preços diferentes e estão no mesmo documento.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.users.getPricing">
    <UserGetPricingResult>
      <ProductType Name="domains">
        <ProductCategory Name="renew">
          <Product Name="com">
            <Price Duration="1" DurationType="YEAR" Price="18.48" RegularPrice="20.98" YourPrice="18.48" YourAdditonalCost="0.20" Currency="USD" />
            <Price Duration="2" DurationType="YEAR" Price="36.96" YourPrice="36.96" YourAdditonalCost="0.40" Currency="USD" />
          </Product>
          <Product Name="co.uk">
            <Price Duration="1" DurationType="YEAR" Price="9.98" YourPrice="8.48" Currency="USD" />
          </Product>
          <Product Name="online">
            <Price Duration="1" DurationType="YEAR" Price="34.98" YourPrice="34.98" YourAdditonalCost="0.18" Currency="USD" />
          </Product>
          <Product Name="grafia">
            <Price Duration="1" DurationType="YEAR" YourPrice="10.00" YourAdditionalCost="0.50" Currency="USD" />
          </Product>
          <Product Name="sodois">
            <Price Duration="2" DurationType="YEAR" YourPrice="99.98" Currency="USD" />
          </Product>
          <Product Name="emmeses">
            <Price Duration="1" DurationType="MONTH" YourPrice="2.00" Currency="USD" />
          </Product>
          <Product Name="semPreco">
            <Price Duration="1" DurationType="YEAR" Price="15.00" Currency="USD" />
          </Product>
        </ProductCategory>
        <ProductCategory Name="register">
          <Product Name="com">
            <Price Duration="1" DurationType="YEAR" YourPrice="0.99" YourAdditonalCost="0.20" Currency="USD" />
          </Product>
          <Product Name="soNoRegister">
            <Price Duration="1" DurationType="YEAR" YourPrice="5.00" Currency="USD" />
          </Product>
        </ProductCategory>
      </ProductType>
    </UserGetPricingResult>
  </CommandResponse>
</ApiResponse>`;

// ── arreio ──────────────────────────────────────────────────────────────

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond: !!cond, detalhe });

const lidos = lerPrecos(XML);
const porTld = new Map(lidos.map((p) => [p.tld, p]));
const tem = (t) => porTld.get(t);

// ── o caso comum ────────────────────────────────────────────────────────

ok(
  'le o .com de 1 ano, com YourPrice e taxa ICANN separados',
  tem('.com')?.renovacao === 18.48 && tem('.com')?.icann === 0.2,
  JSON.stringify(tem('.com')),
);

ok(
  'PEGA YourPrice, NAO Price nem RegularPrice -- YourPrice e o preco desta '
    + 'conta, com o desconto dela; os outros dois sao tabela publica, que e '
    + 'exatamente o que a tabela escrita a mao tinha de errado',
  tem('.com')?.renovacao === 18.48 && tem('.com')?.renovacao !== 20.98,
);

ok(
  'a terminacao vem COM o ponto, como terminacaoDe() devolve no painel',
  lidos.every((p) => p.tld.startsWith('.')),
  lidos.map((p) => p.tld).join(' '),
);

// ── as exclusões, que é onde um leitor desatento erra ───────────────────

ok(
  'SO a linha de 1 ano: o .com tambem tem linha de 2 anos por US$ 36,96 e '
    + 'ela nao pode vazar para a tabela',
  lidos.filter((p) => p.tld === '.com').length === 1,
);

ok(
  'terminacao que so vende a partir de 2 anos fica DE FORA -- dividir o '
    + 'preco de 2 anos por 2 seria inventar um preco que a Namecheap nao da',
  !tem('.sodois'),
);

ok(
  'duracao em MES fica de fora: Duration="1" sozinho nao basta, tem de ser '
    + 'DurationType="YEAR"',
  !tem('.emmeses'),
);

ok(
  'SEM YourPrice A TERMINACAO SAI, nao entra com zero -- zero somaria na '
    + 'conta dizendo que renovar aquele dominio e de graca',
  !tem('.semPreco') && !tem('.semspreco'),
);

ok(
  'o bloco "register" NAO e lido: sao precos diferentes no mesmo documento, '
    + 'e registrar .com custa US$ 0,99 contra US$ 18,48 de renovar',
  !tem('.sonoregister') && tem('.com')?.renovacao !== 0.99,
);

// ── taxa ICANN ──────────────────────────────────────────────────────────

ok(
  'ccTLD sem ICANN vem com zero -- aqui zero e o valor certo, a taxa '
    + 'realmente nao existe para .co.uk',
  tem('.co.uk')?.icann === 0 && tem('.co.uk')?.renovacao === 8.48,
  JSON.stringify(tem('.co.uk')),
);

ok(
  'nome com ponto no meio nao vira duas terminacoes',
  tem('.co.uk') && !tem('.uk'),
);

ok(
  'taxas ICANN diferentes nao se confundem entre terminacoes',
  tem('.online')?.icann === 0.18 && tem('.com')?.icann === 0.2,
);

ok(
  'SE A NAMECHEAP CORRIGIR O TYPO deles (Additonal -> Additional), a coleta '
    + 'continua lendo a taxa em vez de zera-la calada',
  tem('.grafia')?.icann === 0.5,
  JSON.stringify(tem('.grafia')),
);

// ── casos degenerados ───────────────────────────────────────────────────

ok('XML sem bloco renew devolve lista vazia, nao quebra', lerPrecos('<a/>').length === 0);
ok('string vazia devolve lista vazia', lerPrecos('').length === 0);

ok(
  'nenhuma terminacao repetida -- upsert por tld quebraria com duplicata '
    + 'no mesmo lote',
  new Set(lidos.map((p) => p.tld)).size === lidos.length,
);

ok(
  'todo preco lido e numero finito e positivo',
  lidos.every(
    (p) => Number.isFinite(p.renovacao) && p.renovacao > 0 && Number.isFinite(p.icann) && p.icann >= 0,
  ),
);

// ── leitura por CATEGORIA ───────────────────────────────────────────────
//
// O mesmo documento traz `renew` e `register`, e os dois sao precos bem
// diferentes: registrar .com sai por US$ 0,99 no primeiro ano contra
// US$ 18,48 de renovar. Confundir os dois e o erro mais facil aqui -- e o
// que decide se a compra por IA passa no teto de US$ 5,00 e o REGISTRO.

const registro = lerPrecos(XML, 'register');
const porTldReg = new Map(registro.map((p) => [p.tld, p]));

ok(
  'le o bloco register quando pedido, com OUTRO preco',
  porTldReg.get('.com')?.renovacao === 0.99,
  String(porTldReg.get('.com')?.renovacao),
);
ok(
  'OS DOIS NAO SE MISTURAM: o mesmo .com da 18,48 em renew e 0,99 em '
    + 'register, no MESMO documento',
  tem('.com').renovacao === 18.48 && porTldReg.get('.com').renovacao === 0.99,
);
ok(
  'terminacao que so existe em register nao vaza para renew',
  !tem('.sonoregister') && porTldReg.has('.sonoregister'),
);
ok(
  'o padrao continua sendo renew -- o coletor diario chama sem argumento',
  lerPrecos(XML).length === lerPrecos(XML, 'renew').length,
);
ok(
  'categoria inexistente devolve lista vazia, nao quebra',
  lerPrecos(XML, 'inexistente').length === 0,
);
ok(
  'CATEGORIA SO ACEITA LETRAS -- ela entra numa expressao regular, e vem de '
    + 'query string na rota de consulta',
  lerPrecos(XML, 'renew">([sS]*?)<').length === 0
    && lerPrecos(XML, '.*').length === 0,
);

// ── resultado ───────────────────────────────────────────────────────────

console.log('\nPROVAS — LEITOR DE PRECOS DA NAMECHEAP\n');
let falhas = 0;
for (const p of provas) {
  if (!p.cond) falhas++;
  console.log(`  ${p.cond ? 'ok ' : 'FALHOU'}  ${p.rot}${p.cond || !p.detalhe ? '' : `  — ${p.detalhe}`}`);
}
console.log(`\n${provas.length} provas, ${falhas} falha(s).`);
console.log(`Terminacoes lidas: ${lidos.map((p) => p.tld).join(', ')}\n`);
process.exit(falhas ? 1 : 0);
