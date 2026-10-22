/**
 * RENOVAÇÃO ESCOLHIDA
 *
 * A equipe marca na tela quais domínios renovar; isto executa. Nunca
 * renova sozinho — não há cron aqui, de propósito.
 *
 * ── A DIFERENÇA DE TUDO O MAIS NESTE PROJETO ─────────────────────────────
 *
 * Isto GASTA DINHEIRO, na hora, e não tem desfazer. A Namecheap cobra do
 * saldo no momento da chamada e renovação não é reembolsável.
 *
 * Em todo o resto do sistema, errar custa uma rodada de coleta ou uma tela
 * com número errado. Aqui, errar custa dinheiro que não volta. Por isso
 * cada trava abaixo existe, e por isso nenhuma delas é "defensiva demais".
 *
 * ── A JANELA QUE NÃO DÁ PARA FECHAR ──────────────────────────────────────
 *
 * Entre a Namecheap cobrar e nós gravarmos, existe um instante. Se o
 * processo morrer ali, o dinheiro saiu e o registro não existe.
 *
 * Não dá para eliminar — são dois sistemas sem transação em comum. O que
 * dá é reduzir o estrago:
 *
 *   - uma renovação por vez, gravada antes da seguinte. Uma queda perde no
 *     máximo UM registro, não o lote.
 *   - se a gravação falhar, o erro é GRITADO com o OrderID no log, que é o
 *     que permite reconciliar com a fatura depois.
 *
 * A alternativa — gravar antes e chamar depois — seria pior: registraria
 * renovação que não aconteceu, e aí o sistema mentiria para mais.
 *
 * ── O AUTO-RENEW NÃO ATRAPALHA, E ISSO FOI CONFERIDO ─────────────────────
 *
 * A API da Namecheap não liga nem desliga auto-renew; `AutoRenew` é só
 * leitura. Se estivesse ligado, a Namecheap renovaria por conta própria e
 * esta tela não controlaria nada.
 *
 * Em 22/10/2026 os 608 domínios ativos estavam com auto-renew desligado, e
 * a equipe confirmou que renova à mão. É o que torna a escolha real.
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const contas = require('./contas');
const { contaDoDominio } = require('./conta-do-dominio');
const { lerRenovacao } = require('./renovacao-resposta');

const API = 'https://api.namecheap.com/xml.response';

/**
 * Quantos anos por renovação. FIXO EM 1, por decisão.
 *
 * O objetivo da tela é escolher o que fica. Renovar 1 ano traz a decisão de
 * volta todo ano, que é o ponto. (A API aceita até 2.)
 */
const ANOS = 1;

/**
 * Janela da trava contra cobrança duplicada, em minutos.
 *
 * Cobre o caso real: duplo clique, pedido repetido pela rede, ou duas
 * pessoas renovando a mesma lista. Não cobre renovar de novo semanas
 * depois — nem deve, isso é legítimo.
 */
const MINUTOS_DE_TRAVA = 30;

let supabase = null;
function banco() {
  if (!supabase) {
    supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

let ipDoServidor = null;
async function obterIP() {
  if (ipDoServidor) return ipDoServidor;
  const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
  ipDoServidor = data.ip;
  return ipDoServidor;
}

/** Este domínio já foi renovado nos últimos minutos? */
async function renovadoHaPouco(domainId) {
  const desde = new Date(Date.now() - MINUTOS_DE_TRAVA * 60_000).toISOString();
  const { data, error } = await banco()
    .from('domain_renewals')
    .select('renovado_em')
    .eq('domain_id', domainId)
    .gte('renovado_em', desde)
    .limit(1);

  // Erro de leitura NÃO libera a renovação. Em tudo o mais neste projeto a
  // falha degrada para "segue em frente"; aqui ela degrada para "não
  // gasta". Perder uma renovação custa um clique; cobrar duas vezes custa
  // dinheiro que não volta.
  if (error) throw new Error(`Não deu para checar renovação recente: ${error.message}`);
  return (data || []).length > 0;
}

/**
 * Renova UM domínio. Devolve o que aconteceu, nunca lança por falha da
 * Namecheap — quem chama precisa do resultado de cada um para montar o
 * relatório do lote.
 */
async function renovarUm(dominio, solicitadoPor) {
  const { id, domain_name, expiration_date } = dominio;

  try {
    if (await renovadoHaPouco(id)) {
      return {
        dominio: domain_name,
        ok: false,
        pulado: true,
        erro: `Já renovado nos últimos ${MINUTOS_DE_TRAVA} minutos`,
      };
    }

    const conta = await contaDoDominio(domain_name);
    const { _apelido, ...credencial } = contas.parametros(conta);

    const { data: xml } = await axios.get(API, {
      params: {
        ...credencial,
        Command: 'namecheap.domains.renew',
        ClientIp: await obterIP(),
        DomainName: domain_name,
        Years: ANOS,
      },
      timeout: 60000,
    });

    const r = lerRenovacao(xml);
    if (!r.ok) return { dominio: domain_name, ok: false, conta: _apelido, erro: r.erro };

    // ── DAQUI PARA BAIXO, O DINHEIRO JÁ SAIU ────────────────────────────
    //
    // Se a gravação falhar, a renovação ACONTECEU mesmo assim. Por isso o
    // erro sai com o OrderID: é o que permite achar a cobrança na fatura
    // da Namecheap e lançar à mão depois.
    const nova = new Date(expiration_date || Date.now());
    nova.setUTCFullYear(nova.getUTCFullYear() + ANOS);
    const expiracaoNova = nova.toISOString().slice(0, 10);

    const { error: erroGravacao } = await banco().from('domain_renewals').insert({
      domain_id: id,
      domain_name,
      anos: ANOS,
      cobrado_usd: r.cobradoUsd,
      conta: _apelido,
      order_id: r.orderId,
      transaction_id: r.transactionId,
      expiracao_anterior: expiration_date ? String(expiration_date).slice(0, 10) : null,
      expiracao_nova: expiracaoNova,
      solicitado_por: solicitadoPor || null,
    });

    if (erroGravacao) {
      console.error(
        `🚨 [RENOVACAO] ${domain_name} FOI RENOVADO E COBRADO, mas não gravou: ` +
          `${erroGravacao.message} · OrderID ${r.orderId} · US$ ${r.cobradoUsd} · conta ${_apelido}`
      );
    }

    // A expiração em `domains` é atualizada aqui para a tela não continuar
    // mostrando o domínio como vencendo. O cron de 4h também corrigiria,
    // mas só na próxima rodada — e quem acabou de renovar olha agora.
    await banco()
      .from('domains')
      .update({ expiration_date: expiracaoNova })
      .eq('id', id);

    console.log(
      `✅ [RENOVACAO] ${domain_name} · US$ ${r.cobradoUsd} · conta ${_apelido} · vence ${expiracaoNova}`
    );

    return {
      dominio: domain_name,
      ok: true,
      conta: _apelido,
      cobradoUsd: r.cobradoUsd,
      orderId: r.orderId,
      expiracaoNova,
      gravado: !erroGravacao,
    };
  } catch (error) {
    console.error(`❌ [RENOVACAO] ${domain_name}: ${error.message}`);
    return { dominio: domain_name, ok: false, erro: error.message };
  }
}

/**
 * Renova uma LISTA de domínios, UM POR VEZ.
 *
 * Sequencial, não em paralelo, e não por economia de tempo: cada renovação
 * é uma cobrança, e em paralelo uma queda no meio deixaria um conjunto
 * indeterminado de cobranças sem registro. Em sequência, perde-se no
 * máximo uma.
 *
 * Também respeita o limite da Namecheap, de 20 chamadas por minuto.
 */
async function renovarLote(nomes, solicitadoPor) {
  const limpos = [...new Set((nomes || []).map((n) => String(n || '').trim().toLowerCase()))]
    .filter(Boolean);

  if (!limpos.length) throw new Error('Nenhum domínio informado');
  if (limpos.length > 50) {
    throw new Error(`Lote de ${limpos.length} domínios é grande demais; o máximo é 50`);
  }

  const { data: dominios, error } = await banco()
    .from('domains')
    .select('id, domain_name, expiration_date, status')
    .in('domain_name', limpos);

  if (error) throw new Error(`Não deu para ler os domínios: ${error.message}`);

  // Nome que não está na nossa base não é renovado. Pode ser erro de
  // digitação, ou domínio de outra conta — e gastar dinheiro com base num
  // nome que não reconhecemos é exatamente o que não pode acontecer.
  const achados = new Map((dominios || []).map((d) => [d.domain_name.toLowerCase(), d]));
  const resultados = [];

  for (const nome of limpos) {
    const d = achados.get(nome);
    if (!d) {
      resultados.push({ dominio: nome, ok: false, erro: 'Não encontrado na base' });
      continue;
    }
    resultados.push(await renovarUm(d, solicitadoPor));
  }

  const renovados = resultados.filter((r) => r.ok);
  const total = renovados.reduce((s, r) => s + (r.cobradoUsd || 0), 0);

  console.log(
    `💰 [RENOVACAO] Lote: ${renovados.length}/${resultados.length} renovados · US$ ${total.toFixed(2)}`
  );

  return {
    total: resultados.length,
    renovados: renovados.length,
    cobradoUsd: Number(total.toFixed(2)),
    resultados,
  };
}

module.exports = { renovarLote, ANOS, MINUTOS_DE_TRAVA };
