/**
 * LEITURA DA RESPOSTA DO `domain-check` DO CLOUDFLARE REGISTRAR
 *
 * Função pura, SEM NENHUMA DEPENDÊNCIA — nem `config`, nem `axios`. Mora
 * separada de `registrar.js` por isso: `config/env` lança quando falta
 * variável de ambiente, e provar o formato de uma resposta não pode exigir
 * as credenciais de produção.
 *
 * É o mesmo arranjo de `namecheap/pricing-xml.js` e `purchase-domains/tld.js`,
 * e pela mesma razão. Esta é a TERCEIRA vez no projeto que o parser nasceu
 * junto do I/O e precisou ser separado para poder ser testado.
 *
 * As provas estão em `src/scripts/testa-sonda-registrar.js`.
 */

/**
 * LÊ A RESPOSTA DO `domain-check`. Função pura, sem rede.
 *
 * Separada do I/O pelo mesmo motivo que o leitor de XML da Namecheap: o que
 * quebra aqui é o FORMATO, e provar formato não pode exigir credencial nem
 * interceptar `axios`.
 *
 * E este parser já errou. A primeira versão supôs quatro nomes de campo e
 * acertou zero:
 *
 *   enviava `domain_names`      era `domains`
 *   lia `result`                era `result.domains`
 *   lia `available`             era `registrable`
 *   lia `price` / `fees`        era `pricing.registration_cost`, em STRING
 *
 * As provas estão em `src/scripts/testa-sonda-registrar.js`.
 */
function interpretar(resposta, nome, teto) {
  if (!resposta?.success) {
    const erros = (resposta?.errors || []).map((e) => `${e.code}: ${e.message}`);
    return {
      ok: false,
      erro: erros.length ? erros.join(' · ') : 'Resposta sem sucesso e sem erro declarado',
      bruto: resposta,
    };
  }

  // `result.domains`, não `result` direto. A resposta pode OMITIR nomes
  // malformados, então procurar pelo nome é mais seguro que pegar o
  // primeiro.
  const lista = resposta?.result?.domains ?? [];
  const achado = lista.find((d) => d?.name === nome) ?? lista[0] ?? null;

  const preco = achado?.pricing ?? null;
  // Os valores vêm como STRING. Converter aqui, uma vez, em vez de deixar
  // quem lê descobrir isso comparando texto com número.
  const num = (v) => (v == null ? null : Number(v));
  const registro = num(preco?.registration_cost);

  return {
    ok: true,
    dominio: nome,

    // `registrable` responde direto a pergunta que motivou a sonda: dá para
    // registrar ISTO por API?
    registravelPorApi: achado?.registrable ?? null,

    // Distingue casos com conclusões OPOSTAS:
    //   domain_unavailable              nome tomado, tente outro
    //   extension_not_supported_via_api existe no painel, não na API --
    //                                   isto mata a compra automática
    //   domain_premium                  premium, a API não registra
    motivo: achado?.reason ?? null,

    // Propriedade do NOME, não da terminação: um `.com` qualquer serve, um
    // `.com` curto e cobiçado é premium e a API recusa.
    tier: achado?.tier ?? null,

    registroUsd: registro,
    renovacaoUsd: num(preco?.renewal_cost),
    moeda: preco?.currency ?? null,

    // O teto é sobre o REGISTRO, que é o que a compra paga na hora.
    tetoDaCompraPorIA: teto,
    passaNoTeto: registro === null ? null : registro <= teto,

    bruto: achado,
  };
}

module.exports = { interpretar };
