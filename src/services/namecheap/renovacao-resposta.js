/**
 * LEITURA DA RESPOSTA DE `namecheap.domains.renew`
 *
 * Função pura, SEM NENHUMA DEPENDÊNCIA. Separada do serviço pelo mesmo
 * motivo de `pricing-xml.js`, `tld.js` e `registrar-resposta.js`:
 * `config/env` lança sem credencial, e provar a leitura de um XML não pode
 * exigir as chaves de produção.
 *
 * É a quarta vez no projeto. Desta vez nasceu separado.
 *
 * ── O QUE AQUI É CRÍTICO ─────────────────────────────────────────────────
 *
 * `Renew="true"` é o que diz que a renovação aconteceu, e ele é DIFERENTE
 * de a requisição ter dado certo. A Namecheap responde HTTP 200 com o erro
 * dentro do XML — testar só o HTTP concluiria que cobrou quando não cobrou,
 * e o sistema registraria uma renovação que não existe.
 *
 * As provas estão em `src/scripts/testa-renovacao.js`.
 */

/** Texto de um atributo do XML. */
function attr(xml, nome) {
  const m = String(xml).match(new RegExp(nome + '="([^"]*)"'));
  return m ? m[1] : null;
}

/**
 * Lê a resposta de `domains.renew`.
 *
 * `Renew="true"` é o que diz que deu certo — e ele é DIFERENTE de a
 * requisição ter sucesso. A Namecheap responde HTTP 200 com o erro dentro
 * do XML, então testar só o HTTP acharia que cobrou quando não cobrou.
 */
function lerRenovacao(xml) {
  const erro = String(xml).match(/<Error Number="(\d+)">([^<]*)<\/Error>/i);
  if (erro) return { ok: false, erro: `${erro[1]}: ${erro[2]}` };

  const bloco = String(xml).match(/<DomainRenewResult[^>]*>/i);
  if (!bloco) return { ok: false, erro: 'Resposta sem DomainRenewResult' };

  const renovou = (attr(bloco[0], 'Renew') || '').toLowerCase() === 'true';
  if (!renovou) return { ok: false, erro: 'Namecheap respondeu Renew="false"' };

  const cobrado = attr(bloco[0], 'ChargedAmount');
  return {
    ok: true,
    // `ChargedAmount` é o que saiu do saldo de verdade. Todo o resto do
    // painel usa preço de TABELA; este é o único número real que temos.
    cobradoUsd: cobrado === null ? null : Number(cobrado),
    orderId: attr(bloco[0], 'OrderID'),
    transactionId: attr(bloco[0], 'TransactionID'),
    domainId: attr(bloco[0], 'DomainID'),
  };
}

module.exports = { lerRenovacao };
