/**
 * SONDA DO CLOUDFLARE REGISTRAR
 *
 * SÓ CONSULTA. Não registra domínio, não gasta dinheiro, não grava no banco.
 * Existe para decidir se a compra de `.com` pela Cloudflare é viável, com
 * número na mão, antes de escrever o fluxo de compra.
 *
 * ── O QUE PRECISA SER RESPONDIDO ANTES DE CONSTRUIR ──────────────────────
 *
 *   1. `.com` é registrável POR API nesta conta? A API está em BETA e nem
 *      toda terminação que o painel vende está liberada nela.
 *   2. Por quanto? A Cloudflare vende a preço de custo, então o número deve
 *      ser diferente dos ~US$ 11 que a base pagou na Namecheap.
 *   3. A conta está pronta? Token, perfil de cobrança, contato de
 *      registrante e aceite do contrato.
 *
 * A terceira é a que mais engana: sem cartão configurado, o `check` responde
 * normalmente e só o registro falha. Por isso a sonda consulta também o
 * endereço da conta e diz o que encontrou.
 *
 * ── A CONTA É OUTRA ──────────────────────────────────────────────────────
 *
 * `CLOUDFLARE_ACCOUNT_ID` é a conta atual, de DNS e analytics dos 584
 * domínios. `CLOUDFLARE_REGISTRAR_ACCOUNT_ID` é a conta nova, que vai
 * comprar. Autenticação diferente também: aqui é token Bearer com permissão
 * de Registrar write, não o par e-mail + chave global do resto do código.
 *
 * ── POR QUE `domain-check` E NÃO `domain-search` ─────────────────────────
 *
 * `search` sugere nomes a partir de uma palavra. `check` responde sobre um
 * nome ESPECÍFICO, e a documentação diz que o preço dele é a fonte da
 * verdade, para ser chamado imediatamente antes de registrar. É o mesmo
 * endpoint que o fluxo de compra vai usar — sondar com ele é sondar o
 * caminho real, não um parecido.
 */

const axios = require('axios');
const config = require('../../config/env');

const API = 'https://api.cloudflare.com/client/v4';

/** `null` quando a conta nova ainda não foi configurada. */
function credenciais() {
  const id = config.CLOUDFLARE_REGISTRAR_ACCOUNT_ID;
  const token = config.CLOUDFLARE_REGISTRAR_API_TOKEN;
  if (!id || !token) return null;
  return { id, token };
}

async function pedir(metodo, caminho, corpo) {
  const cred = credenciais();
  const { data } = await axios({
    method: metodo,
    url: `${API}/accounts/${cred.id}${caminho}`,
    headers: {
      Authorization: `Bearer ${cred.token}`,
      'Content-Type': 'application/json',
    },
    data: corpo,
    timeout: 30000,
    // A Cloudflare responde 4xx com o motivo no corpo. Sem isto, o axios
    // lança e o motivo — que é justamente o que a sonda quer mostrar — se
    // perde dentro da exceção.
    validateStatus: () => true,
  });
  return data;
}

/**
 * Consulta UM domínio: disponível, registrável por API, e por quanto.
 *
 * Devolve a resposta já digerida, mas com `bruto` junto: a API está em beta
 * e o formato pode mudar. Quando mudar, é melhor ver o que veio do que
 * receber `undefined` sem explicação.
 */
async function sondar(dominio) {
  const nome = String(dominio || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+\.[a-z.]+$/.test(nome)) {
    throw new Error(`Domínio inválido para sonda: ${dominio}`);
  }

  if (!credenciais()) {
    return {
      configurado: false,
      falta: [
        !config.CLOUDFLARE_REGISTRAR_ACCOUNT_ID && 'CLOUDFLARE_REGISTRAR_ACCOUNT_ID',
        !config.CLOUDFLARE_REGISTRAR_API_TOKEN && 'CLOUDFLARE_REGISTRAR_API_TOKEN',
      ].filter(Boolean),
      comoResolver:
        'Conta nova da Cloudflare: criar token com permissão de Registrar write ' +
        'e pegar o Account ID no painel. Depois configurar as duas no Render.',
    };
  }

  const resposta = await pedir('POST', '/registrar/domain-check', { domain_names: [nome] });

  if (!resposta?.success) {
    const erros = (resposta?.errors || []).map((e) => `${e.code}: ${e.message}`);
    return {
      configurado: true,
      ok: false,
      // O erro mais provável aqui é token sem a permissão certa, e a
      // mensagem da Cloudflare diz isso com todas as letras.
      erro: erros.length ? erros.join(' · ') : 'Resposta sem sucesso e sem erro declarado',
      bruto: resposta,
    };
  }

  // O formato do `result` ainda pode mudar: a API está em beta. Por isso a
  // leitura é defensiva e o bruto vai junto.
  const lista = Array.isArray(resposta.result) ? resposta.result : [resposta.result];
  const achado = lista.find((d) => d?.domain_name === nome) ?? lista[0] ?? null;

  return {
    configurado: true,
    ok: true,
    dominio: nome,
    disponivel: achado?.available ?? null,
    // `reason` é o campo que distingue "alguém já tem" de "a API não vende
    // esta terminação" — são conclusões opostas e a sonda existe por causa
    // dessa diferença.
    motivo: achado?.reason ?? null,
    registravelPorApi: achado?.reason !== 'extension_not_supported_via_api',
    precoUsd: achado?.price ?? achado?.fees?.registration ?? null,
    moeda: achado?.currency ?? null,
    bruto: achado,
  };
}

/**
 * A conta está pronta para registrar?
 *
 * Só confirma que o token alcança a conta e devolve o nome dela. NÃO há
 * endpoint público que diga "tem cartão cadastrado" — isso só se descobre
 * no primeiro registro, que é exatamente o que esta sonda NÃO faz.
 *
 * Então isto responde metade da pergunta, e a função diz qual metade.
 */
async function conferirConta() {
  if (!credenciais()) return { configurado: false };

  const resposta = await pedir('GET', '');
  return {
    configurado: true,
    ok: !!resposta?.success,
    conta: resposta?.result?.name ?? null,
    id: resposta?.result?.id ?? null,
    erro: resposta?.success
      ? null
      : (resposta?.errors || []).map((e) => `${e.code}: ${e.message}`).join(' · '),
    aviso:
      'Token e conta alcançáveis. NÃO confirma cartão, contato de registrante ' +
      'nem aceite do contrato — isso só aparece no primeiro registro de verdade.',
  };
}

module.exports = { sondar, conferirConta };
