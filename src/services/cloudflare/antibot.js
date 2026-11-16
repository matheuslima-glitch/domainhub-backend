/**
 * ANTIBOT EM LOTE — CHAMADAS À CLOUDFLARE
 *
 * Executa o que `antibot-regras.js` decide. Só a rota `POST /api/antibot/lote`
 * chama, com a trava de super admin.
 *
 * Mudança OpenSpec: openspec/changes/antibot-em-lote.
 *
 * ── POR QUE A API DE RULESETS ────────────────────────────────────────────
 *
 * A compra cria as regras de `sitemap` e `?s=` pela API antiga
 * (`/filters` + `/firewall/rules`), sem suporte desde 15/06/2025. Hoje o
 * primeiro passo ainda grava, mas a regra fica "Unused filter" e DESATIVADA,
 * e o segundo falha. Por isso aqui é só Rulesets, fase
 * `http_request_firewall_custom`:
 *
 *   GET    /zones/{z}/rulesets/phases/{fase}/entrypoint   ler (404 = sem conjunto)
 *   PUT    /zones/{z}/rulesets/phases/{fase}/entrypoint   criar conjunto
 *   POST   /zones/{z}/rulesets/{c}/rules                  acrescentar regra
 *   PATCH  /zones/{z}/rulesets/{c}/rules/{r}              reativar
 *   DELETE /zones/{z}/rulesets/{c}/rules/{r}              remover
 *
 * ── O PUT É PERIGOSO ─────────────────────────────────────────────────────
 *
 * O PUT no entrypoint SUBSTITUI todas as regras da fase. Ele só é usado
 * quando a leitura acabou de dar 404, ou seja, quando não havia nada para
 * substituir. Com conjunto existente, a regra entra pelo POST.
 *
 * ── CREDENCIAL ───────────────────────────────────────────────────────────
 *
 * A mesma chave global do resto do backend (CLOUDFLARE_EMAIL + _API_KEY),
 * que enxerga todas as zonas da conta principal.
 */

const axios = require('axios');
const config = require('../../config/env');
const regras = require('./antibot-regras');

const API = 'https://api.cloudflare.com/client/v4';
const PAUSA_MS = 250; // entre domínios; ~4 chamadas por domínio, longe de 1.200/5min
const TIMEOUT_MS = 30000;

const ENTRYPOINT = (zonaId) => `/zones/${zonaId}/rulesets/phases/${regras.FASE}/entrypoint`;

let emAndamento = false;

function cabecalhos() {
  return {
    'X-Auth-Email': config.CLOUDFLARE_EMAIL,
    'X-Auth-Key': config.CLOUDFLARE_API_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Faz a chamada sem lançar em 4xx/5xx: o status e o corpo voltam para quem
 * chamou decidir. O 404 do entrypoint, por exemplo, é resposta, não erro.
 */
async function pedir(metodo, caminho, corpo) {
  const r = await axios({
    method: metodo,
    url: `${API}${caminho}`,
    headers: cabecalhos(),
    data: corpo,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
  return { status: r.status, data: r.data };
}

/** Lança com a mensagem da Cloudflare quando a resposta não é sucesso. */
function exigirSucesso(resposta, rotulo) {
  if (resposta.data && resposta.data.success) return resposta.data.result;
  const motivos = (resposta.data?.errors || []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join(' · ');
  throw new Error(`${rotulo}: HTTP ${resposta.status}${motivos ? ` (${motivos})` : ''}`);
}

/** Nome da zona principal, para recusá-la pelo nome mesmo fora da base. */
async function nomeDaZonaPrincipal() {
  if (!config.CLOUDFLARE_MAIN_ZONE_ID) return null;
  try {
    const zona = exigirSucesso(await pedir('GET', `/zones/${config.CLOUDFLARE_MAIN_ZONE_ID}`), 'ler zona principal');
    return String(zona?.name || '').toLowerCase() || null;
  } catch (e) {
    // Sem o nome, a proteção continua pelo id (ver processarDominio).
    console.warn(`⚠️ [ANTIBOT] Não foi possível ler o nome da zona principal: ${e.message}`);
    return null;
  }
}

/** A zona com EXATAMENTE este nome, ou `null`. */
async function buscarZona(dominio) {
  const lista = exigirSucesso(
    await pedir('GET', `/zones?name=${encodeURIComponent(dominio)}`),
    'procurar zona'
  ) || [];
  return lista.find((z) => String(z?.name || '').toLowerCase() === dominio) || null;
}

/** O conjunto de regras personalizadas da zona, ou `null` se a zona nunca teve um. */
async function lerConjunto(zonaId) {
  const resposta = await pedir('GET', ENTRYPOINT(zonaId));
  if (resposta.status === 404) return null;
  return exigirSucesso(resposta, 'ler regras da zona');
}

/** Executa a escrita decidida. Só é chamada fora da simulação. */
async function executar(escrita, zonaId) {
  switch (escrita.tipo) {
    case 'criar_conjunto':
      return exigirSucesso(
        await pedir('PUT', ENTRYPOINT(zonaId), { rules: [regras.regraNova()] }),
        'criar conjunto de regras'
      );
    case 'criar_regra':
      return exigirSucesso(
        await pedir('POST', `/zones/${zonaId}/rulesets/${escrita.conjuntoId}/rules`, {
          ...regras.regraNova(),
          position: { index: 1 },
        }),
        'criar regra'
      );
    case 'reativar': {
      // Reenvia a própria regra como está, só ligando: a expressão de uma
      // regra antiga não é trocada aqui (design, decisão 4).
      const { ref, description, expression, action } = escrita.regra;
      return exigirSucesso(
        await pedir('PATCH', `/zones/${zonaId}/rulesets/${escrita.conjuntoId}/rules/${escrita.regra.id}`, {
          ref, description, expression, action, enabled: true,
        }),
        'reativar regra'
      );
    }
    case 'apagar':
      return exigirSucesso(
        await pedir('DELETE', `/zones/${zonaId}/rulesets/${escrita.conjuntoId}/rules/${escrita.regraId}`),
        'remover regra'
      );
    default:
      throw new Error(`Escrita desconhecida: ${escrita.tipo}`);
  }
}

/** Um domínio, do começo ao fim. Nunca lança: erro vira resultado `erro`. */
async function processarDominio(dominio, modo) {
  const simulado = modo === 'simular';
  try {
    const zona = await buscarZona(dominio);
    if (!zona) return { dominio, resultado: 'sem_zona' };

    if (config.CLOUDFLARE_MAIN_ZONE_ID && zona.id === config.CLOUDFLARE_MAIN_ZONE_ID) {
      return { dominio, resultado: 'recusado', erro: 'É a zona principal' };
    }

    const conjunto = await lerConjunto(zona.id);
    const { resultado, escrita } = regras.decidir({ modo, conjunto });

    if (escrita && !simulado) await executar(escrita, zona.id);

    return simulado ? { dominio, resultado, simulado: true } : { dominio, resultado };
  } catch (e) {
    return { dominio, resultado: 'erro', erro: e.message };
  }
}

/** Um lote está rodando agora? A rota usa para responder 409 antes de começar. */
function ocupado() {
  return emAndamento;
}

/**
 * Roda o lote, um domínio por vez.
 *
 * @param {object} p
 * @param {string} p.modo         simular | aplicar | remover (já validado)
 * @param {string[]} p.dominios   já normalizados
 * @param {Set<string>} p.conhecidos  os que existem em `domains`; os outros
 *                                    saem `desconhecido` sem chamada à Cloudflare
 * @returns {Promise<object>} relatório, ou `{ ocupado: true }` se já havia lote
 */
async function rodarLote({ modo, dominios, conhecidos }) {
  if (emAndamento) return { ocupado: true };
  emAndamento = true;

  try {
    const principal = await nomeDaZonaPrincipal();
    const itens = [];

    for (let i = 0; i < dominios.length; i++) {
      const dominio = dominios[i];

      if (principal && dominio === principal) {
        itens.push({ dominio, resultado: 'recusado', erro: 'É a zona principal' });
        continue;
      }
      if (!conhecidos.has(dominio)) {
        itens.push({ dominio, resultado: 'desconhecido' });
        continue;
      }

      itens.push(await processarDominio(dominio, modo));
      if (i < dominios.length - 1) await new Promise((r) => setTimeout(r, PAUSA_MS));
    }

    const relatorio = regras.montarRelatorio(modo, itens);
    const resumo = regras.resumoDeFalhas(relatorio);
    if (resumo) {
      // O distribuidor nunca lança. `critico` faz o Telegram receber.
      await require('../notify').espelhar(resumo, { critico: true });
    }
    return relatorio;
  } finally {
    emAndamento = false;
  }
}

module.exports = { rodarLote, ocupado, processarDominio };
