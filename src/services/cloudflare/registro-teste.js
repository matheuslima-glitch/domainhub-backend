/**
 * REGISTRO DE TESTE: UM `.com` NA CONTA NOVA, APONTADO PARA A CONTA ATUAL
 *
 * Decisão de 05/11/2026: o `.com` é comprado na conta nova e fica nela, com a
 * zona de DNS. Para a conta atual vai só o apontamento: um CNAME para o
 * servidor e o Custom Hostname na zona principal.
 *
 * A documentação não responde o que este teste responde:
 *
 *   1. O registro por API cria a zona sozinho? Em que conta?
 *   2. Cartão, contato de registrante e aceite do contrato estão certos? Isso
 *      só aparece no primeiro registro de verdade.
 *   3. O site funciona com a zona numa conta e o Custom Hostname na outra?
 *
 * ── AS DUAS ETAPAS SÃO SEPARADAS DE PROPÓSITO ────────────────────────────
 *
 * `registrarUm` gasta dinheiro. `apontar` não gasta e pode ser repetido quantas
 * vezes for preciso, inclusive para acompanhar o certificado. Se o apontamento
 * falhar, corrige-se a causa e roda de novo, sem tocar na compra.
 *
 * Nada aqui grava em `domains`: o domínio de teste não entra no painel.
 *
 * O fluxo de compra de verdade vem depois do teste, com o que ele descobrir.
 */

const axios = require('axios');
const config = require('../../config/env');
const registrar = require('./registrar');
const {
  nomeCom,
  motivoParaRecusarPedido,
  motivoParaRecusarConsulta,
  resumirApontamento,
} = require('./registrar-resposta');

const API = 'https://api.cloudflare.com/client/v4';

/** `.com` custava US$ 10,44 em 21/10/2026. O teto só barra um susto de preço. */
const TETO_DO_TESTE_USD = 12;

/** O mesmo destino do `setupCloudflare` da compra WordPress. */
const SERVIDOR = 'servidor.institutoexperience.com.br';

const ESPERA_MS = 5000;
const TENTATIVAS = 12;

const NAO_REPITA =
  'NÃO repita o registro: ele pode ter sido cobrado. Confira em Domain Registration, '
  + 'no painel da conta nova.';

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Um registro por vez neste processo: dois cliques não podem virar duas tentativas.
let emAndamento = false;

/**
 * REGISTRA UM `.com`. GASTA DINHEIRO, SEM REEMBOLSO.
 *
 * Consulta logo antes de comprar, como manda a documentação: só o
 * `domain-check` tem o preço verdadeiro.
 */
async function registrarUm({ dominio, confirmar }) {
  const recusa = motivoParaRecusarPedido(dominio, confirmar);
  if (recusa) return { ok: false, recusado: true, erro: recusa };

  if (emAndamento) {
    return { ok: false, recusado: true, erro: 'Já existe um registro em andamento.' };
  }
  emAndamento = true;

  try {
    const nome = nomeCom(dominio);

    const consulta = await registrar.sondar(nome);
    const barrado = motivoParaRecusarConsulta(consulta, TETO_DO_TESTE_USD);
    if (barrado) return { ok: false, recusado: true, erro: barrado };

    console.log(`💳 [REGISTRAR] Registrando ${nome} por US$ ${consulta.registroUsd}`);

    try {
      let atual = await registrar.registrar(nome);
      if (!atual.ok) return { ok: false, recusado: true, erro: atual.erro, bruto: atual.bruto };

      for (let i = 0; !atual.terminou && i < TENTATIVAS; i++) {
        await esperar(ESPERA_MS);
        atual = await registrar.statusDoRegistro(nome);
        if (!atual.ok) break;
      }

      if (!atual.ok || !atual.terminou) {
        return { ok: false, incerto: true, estado: atual.estado ?? null, aviso: NAO_REPITA };
      }

      console.log(`💳 [REGISTRAR] ${nome} terminou em ${atual.estado}`);
      return {
        ...atual,
        ok: atual.registrado,
        dominio: nome,
        pagoUsd: atual.registrado ? consulta.registroUsd : null,
        renovacaoUsd: consulta.renovacaoUsd,
      };
    } catch (erro) {
      // Sem resposta, não dá para saber se a Cloudflare recebeu o pedido.
      return { ok: false, incerto: true, erro: erro.message, aviso: NAO_REPITA };
    }
  } finally {
    emAndamento = false;
  }
}

/** Chamada com a chave global, a mesma de todo o resto do código. */
async function cloudflare(metodo, caminho, corpo) {
  const { data } = await axios({
    method: metodo,
    url: `${API}${caminho}`,
    headers: {
      'X-Auth-Email': config.CLOUDFLARE_EMAIL,
      'X-Auth-Key': config.CLOUDFLARE_API_KEY,
      'Content-Type': 'application/json',
    },
    data: corpo,
    timeout: 30000,
    validateStatus: () => true,
  });

  if (!data?.success) {
    const erros = (data?.errors || []).map((e) => `${e.code}: ${e.message}`).join(' · ');
    throw new Error(erros || 'Resposta sem sucesso e sem erro declarado');
  }
  return data.result;
}

/** Roda uma etapa e, se falhar, diz qual foi. */
async function etapa(nome, passo) {
  try {
    return await passo();
  } catch (erro) {
    erro.etapa = nome;
    throw erro;
  }
}

/**
 * APONTA O DOMÍNIO PARA A CONTA ATUAL. NÃO GASTA DINHEIRO.
 *
 * Pode rodar de novo: só cria o que falta, e sempre devolve o estado de agora.
 * O certificado leva alguns minutos, então a segunda rodada mostra se ficou
 * ativo.
 */
async function apontar(dominio) {
  const nome = nomeCom(dominio);
  if (!nome) return { ok: false, recusado: true, erro: `Domínio inválido: ${dominio}` };

  const conta = config.CLOUDFLARE_REGISTRAR_ACCOUNT_ID;
  const principal = config.CLOUDFLARE_MAIN_ZONE_ID;
  if (!conta) return { ok: false, recusado: true, erro: 'Falta CLOUDFLARE_REGISTRAR_ACCOUNT_ID.' };
  if (!principal) return { ok: false, recusado: true, erro: 'Falta CLOUDFLARE_MAIN_ZONE_ID.' };

  try {
    const zonas = await etapa('procurar zona', () => cloudflare('GET', `/zones?name=${nome}`));
    let zona = zonas[0] ?? null;
    const zonaVeioPronta = !!zona;

    if (!zona) {
      zona = await etapa('criar zona', () => cloudflare('POST', '/zones', {
        name: nome,
        account: { id: conta },
        jump_start: false,
      }));
    }

    if (zona.account?.id !== conta) {
      return {
        ok: false,
        recusado: true,
        erro: `A zona de ${nome} está em outra conta, não na conta nova.`,
      };
    }

    const hostnames = await etapa('procurar Custom Hostname', () => cloudflare(
      'GET', `/zones/${principal}/custom_hostnames?hostname=${nome}`));
    const hostname = hostnames[0] ?? await etapa('criar Custom Hostname', () => cloudflare(
      'POST', `/zones/${principal}/custom_hostnames`, {
        hostname: nome,
        ssl: { method: 'http', type: 'dv' },
      }));

    const registros = await etapa('procurar CNAME', () => cloudflare(
      'GET', `/zones/${zona.id}/dns_records?type=CNAME&name=${nome}`));
    const registro = registros[0] ?? await etapa('criar CNAME', () => cloudflare(
      'POST', `/zones/${zona.id}/dns_records`, {
        type: 'CNAME',
        name: '@',
        content: SERVIDOR,
        ttl: 1,
        proxied: false,
      }));

    return {
      ok: true,
      dominio: nome,
      zonaVeioPronta,
      ...resumirApontamento(zona, hostname, registro, SERVIDOR),
    };
  } catch (erro) {
    return { ok: false, etapa: erro.etapa ?? null, erro: erro.message };
  }
}

module.exports = { registrarUm, apontar, TETO_DO_TESTE_USD };
