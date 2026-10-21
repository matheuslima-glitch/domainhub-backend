/**
 * O LEITOR DO XML DE PREÇOS DA NAMECHEAP
 *
 * Função pura, SEM NENHUMA DEPENDÊNCIA — nem `config`, nem `axios`, nem
 * Supabase. Mora separada de `pricing.js` por isso: o que quebra num leitor
 * de XML é o formato, não a rede, e o teste disso não pode exigir
 * credencial.
 *
 * (`config/env` lança quando falta variável de ambiente. Com o leitor junto
 * do coletor, rodar as provas na máquina de alguém exigiria as chaves de
 * produção para provar uma expressão regular.)
 *
 * As provas estão em `src/scripts/testa-precos-renovacao.js`.
 *
 * ── O FORMATO ────────────────────────────────────────────────────────────
 *
 *   <ProductType Name="domains">
 *     <ProductCategory Name="renew">          <- e também "register", etc.
 *       <Product Name="com">
 *         <Price Duration="1" DurationType="YEAR"
 *                Price="18.48"              preço de tabela pública
 *                RegularPrice="20.98"       de lista, sem promoção
 *                YourPrice="18.48"          O DESTA CONTA  <- é o que vale
 *                YourAdditonalCost="0.20"   taxa ICANN     <- typo deles
 *                Currency="USD" />
 *         <Price Duration="2" ... />
 *
 * Lido com expressão regular, não com analisador de XML, pela mesma razão
 * que o resto do projeto: é a única dependência que a Namecheap impõe, o
 * formato é estável há anos, e o fluxo de compra já lê assim.
 */

/**
 * Quantos anos o preço cobre.
 *
 * A Namecheap devolve uma linha por duração e algumas terminações só vendem
 * a partir de 2 ou 10 anos. Pegamos 1 ano porque é a unidade em que o painel
 * raciocina — "custo de manter por ano". Quando não existe linha de 1 ano a
 * terminação fica DE FORA, em vez de entrar com o preço de outra duração
 * dividido: isso seria inventar um preço que a Namecheap não oferece.
 */
const ANOS = 1;

/**
 * Número de um atributo, ou `null`.
 *
 * `null` e não `0`: a diferença entre "não informado" e "de graça" é a mesma
 * que o painel faz entre terminação sem preço e preço zero. Zero somaria na
 * conta dizendo que renovar não custa nada.
 */
function atributo(trecho, nome) {
  const m = trecho.match(new RegExp(nome + '="([0-9.]+)"'));
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Lê uma categoria do catálogo e devolve `[{ tld, renovacao, icann }]`.
 *
 * `categoria` é `renew` por padrão, que é o que o coletor diário usa. O
 * mesmo documento traz `register`, e os dois são preços BEM diferentes —
 * registrar um `.com` sai por US$ 0,99 no primeiro ano contra US$ 18,48 de
 * renovar. Confundir os dois é o erro mais fácil de cometer aqui.
 *
 * O campo continua se chamando `renovacao` mesmo lendo `register`: é "o
 * preço desta categoria". Rebatizar daria dois formatos de retorno para a
 * mesma função, e quem chama já sabe o que pediu.
 */
function lerPrecos(xml, categoria = 'renew') {
  // A categoria entra numa expressão regular, então só se aceita palavra:
  // sem isto, um valor vindo de query string poderia alterar o padrão.
  if (!/^[a-z]+$/i.test(String(categoria))) return [];

  const bloco = String(xml || '').match(
    new RegExp(
      '<ProductCategory\\s+Name="' + categoria + '">([\\s\\S]*?)</ProductCategory>',
      'i',
    ),
  );
  if (!bloco) return [];

  const achados = [];
  const produtos = bloco[1].matchAll(
    /<Product\s+Name="([^"]+)">([\s\S]*?)<\/Product>/gi,
  );

  for (const [, nome, corpo] of produtos) {
    const linha = corpo.match(
      new RegExp(`<Price[^>]*Duration="${ANOS}"[^>]*DurationType="YEAR"[^>]*/>`, 'i'),
    );
    if (!linha) continue;

    const renovacao = atributo(linha[0], 'YourPrice');
    // Sem preço não há o que gravar: acontece em terminação que esta conta
    // não pode renovar.
    if (renovacao === null || renovacao <= 0) continue;

    const icann =
      atributo(linha[0], 'YourAdditonalCost') ??
      // Grafia correta, para o dia em que a Namecheap consertar o typo.
      atributo(linha[0], 'YourAdditionalCost') ??
      0;

    achados.push({
      // Com o ponto: é a forma que `terminacaoDe()` devolve no painel e a
      // que a tela mostra. Gravar sem obrigaria os dois lados a lembrar de
      // colar e descolar.
      tld: '.' + String(nome).trim().toLowerCase(),
      renovacao,
      icann,
    });
  }

  return achados;
}

module.exports = { lerPrecos, ANOS };
