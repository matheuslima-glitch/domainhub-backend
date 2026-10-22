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

/**
 * A data da Namecheap em `YYYY-MM-DD`.
 *
 * O `getInfo` devolve `MM/DD/YYYY`; o banco guarda `YYYY-MM-DD`. Comparar
 * os dois sem converter dá resultado silenciosamente errado — e essa
 * comparação é o que decide se uma renovação foi confirmada.
 *
 * Errar aqui para MAIS é o pior defeito possível neste fluxo: o domínio
 * ficaria no banco com data futura falsa, o painel pararia de sinalizá-lo,
 * e ele morreria recebendo tráfego pago.
 *
 * Por isso devolve `null` em qualquer formato que não reconheça, em vez de
 * tentar adivinhar. Nulo faz quem chama NÃO confirmar a renovação, que é o
 * lado seguro do erro.
 */
function normalizarData(bruta) {
  const t = String(bruta ?? '').trim();
  if (!t) return null;

  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mes, dia, ano] = m;
    if (Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) return null;
    return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  }

  // Já em ISO, com ou sem hora.
  const iso = t.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

module.exports = { lerRenovacao, normalizarData };
