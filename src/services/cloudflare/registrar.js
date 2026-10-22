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
const { interpretar } = require('./registrar-resposta');

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

  // O campo é `domains`, PLURAL e sem "name". A primeira versão mandava
  // `domain_names` -- nome inventado por mim, não lido da documentação -- e
  // a Cloudflare respondia `1006: domains array must contain at least one
  // domain`, que parece lista vazia e não campo errado.
  const resposta = await pedir('POST', '/registrar/domain-check', { domains: [nome] });

  const { priceLimit } = new (require('../../purchase-domains/wordpress'))();
  return { configurado: true, ...interpretar(resposta, nome, priceLimit) };
}

/**
 * O token alcança a API de Registrar?
 *
 * ── POR QUE NÃO `GET /accounts/{id}` ─────────────────────────────────────
 *
 * Era assim na primeira versão, e estava errado: ler os dados da conta
 * exige permissão de conta, e um token CORRETAMENTE MÍNIMO — só
 * `Registrar Domains: Admin` — não tem. A verificação falhava justamente
 * quando o token estava certo, e respondia `9109: Unauthorized`, mandando
 * quem investiga desconfiar da permissão que estava boa.
 *
 * Agora bate no próprio `domain-check`, que é o endpoint que importa. Se
 * ele responde, o token serve para o que vamos fazer.
 *
 * ── O QUE ISTO NÃO RESPONDE ──────────────────────────────────────────────
 *
 * Se há cartão cadastrado, contato de registrante e aceite do contrato.
 * Não existe endpoint público para isso: só aparece no primeiro registro
 * de verdade, que é o que esta sonda NÃO faz.
 */
async function conferirConta() {
  if (!credenciais()) return { configurado: false };

  // Nome fixo e improvável. Só interessa se a chamada PASSA, não a resposta.
  const resposta = await pedir('POST', '/registrar/domain-check', {
    domains: ['zz-sonda-de-token-nao-registrar.com'],
  });

  const ok = !!resposta?.success;
  return {
    configurado: true,
    ok,
    erro: ok ? null : (resposta?.errors || []).map((e) => `${e.code}: ${e.message}`).join(' · '),
    aviso: ok
      ? 'Token válido e com permissão de Registrar. NÃO confirma cartão, contato de '
        + 'registrante nem aceite do contrato — isso só aparece no primeiro registro.'
      : 'Se vier 9109, o token não tem "Registrar Domains: Admin" no escopo da conta certa. '
        + 'Se vier erro de IP, o filtro do token não inclui o IP do Render.',
  };
}

module.exports = { sondar, conferirConta };
