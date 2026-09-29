/**
 * TRAVA DE EXCLUSÃO DE DOMÍNIOS
 *
 * Duas regras, definidas com o time em 29/09/2026:
 *
 *   LOTE   — dois ou mais domínios excluídos juntos precisam da aprovação de
 *            um super admin;
 *   RITMO  — a terceira exclusão avulsa da mesma pessoa em 20 minutos também.
 *
 * A segunda existe porque a primeira sozinha não trava nada: bastaria clicar
 * um domínio por vez.
 *
 * ONDE ELA MORA, E POR QUÊ
 *
 * Aqui, no backend, e não no painel. Trava só no painel seria contornável por
 * quem chamasse a API direto — e a API é pública, protegida só por JWT, que
 * qualquer usuário do painel tem.
 *
 * As regras em si estão no banco, em `pode_excluir_dominio()`. Este arquivo é
 * quem pergunta, e quem avisa o Discord.
 *
 * COMO DESLIGAR SEM DEPLOY
 *
 * EXCLUSAO_EXIGE_APROVACAO=false no Render. A verificação passa a devolver
 * "permitido" sempre, e o registro continua acontecendo — assim o histórico
 * não fica com buraco durante o período desligado.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Resolve o id do domínio a partir do nome.
 *
 * Três dos quatro endpoints destrutivos recebem só `domainName` — o
 * `/step/supabase` é o único que já vem com o id. Sem o id não dá para
 * consultar a trava, porque os pedidos guardam id.
 */
async function idDoDominio(domainName) {
  const { data, error } = await supabase
    .from('domains')
    .select('id')
    .eq('domain_name', domainName)
    .maybeSingle();

  if (error) {
    console.error(`❌ [EXCLUSAO] Falha ao resolver id de ${domainName}:`, error.message);
    return null;
  }
  return data ? data.id : null;
}

/**
 * Pergunta se esta pessoa pode excluir este domínio agora.
 *
 * Devolve sempre um objeto com `permitido`. Em caso de erro de infraestrutura
 * — banco fora, função ausente — devolve permitido: true e registra no log.
 *
 * Essa escolha merece explicação: uma trava que barra tudo quando o banco
 * oscila transformaria um problema de disponibilidade numa parada de
 * operação. O custo de errar para o lado permissivo é uma exclusão que
 * escapou; o de errar para o restritivo é ninguém conseguir trabalhar. Como o
 * registro de execuções continua funcionando, uma exclusão que escapa fica
 * visível depois.
 */
async function verificar({ domainId, domainName, userId }) {
  if (!config.EXCLUSAO_EXIGE_APROVACAO) {
    return { permitido: true, motivo: 'trava_desligada' };
  }

  if (!userId) {
    // Sem saber quem é, não dá para aplicar a regra de ritmo. Não barra, mas
    // avisa alto: significa que alguma rota perdeu o middleware de auth.
    console.warn('⚠️ [EXCLUSAO] Chamada sem usuário identificado — trava não aplicada');
    return { permitido: true, motivo: 'sem_usuario' };
  }

  const id = domainId || (domainName ? await idDoDominio(domainName) : null);
  if (!id) {
    console.warn(`⚠️ [EXCLUSAO] Domínio não encontrado (${domainName || domainId}) — trava não aplicada`);
    return { permitido: true, motivo: 'dominio_desconhecido' };
  }

  const { data, error } = await supabase.rpc('pode_excluir_dominio', {
    p_domain_id: id,
    p_user_id: userId,
  });

  if (error) {
    console.error('❌ [EXCLUSAO] Falha ao consultar a trava:', error.message);
    return { permitido: true, motivo: 'erro_na_trava', erro: error.message };
  }

  return { ...data, domainId: id };
}

/**
 * Registra que o domínio saiu. Chamada DEPOIS de a exclusão terminar.
 *
 * Marca o item do pedido como executado, para uma aprovação não virar passe
 * livre permanente, e grava a linha que alimenta a regra de ritmo.
 *
 * Falha aqui não derruba a exclusão — ela já aconteceu, e travar a resposta
 * por causa do registro não desfaz nada. Mas grita no log, porque um buraco
 * aqui enfraquece a regra de ritmo.
 */
async function registrar({ domainId, domainName, userId }) {
  if (!userId) return;

  const id = domainId || (domainName ? await idDoDominio(domainName) : null);
  if (!id) {
    console.error(`❌ [EXCLUSAO] Não registrei a exclusão de ${domainName}: id não resolvido`);
    return;
  }

  const { error } = await supabase.rpc('registrar_exclusao', {
    p_domain_id: id,
    p_domain_name: domainName || id,
    p_user_id: userId,
  });

  if (error) console.error('❌ [EXCLUSAO] Falha ao registrar a exclusão:', error.message);
}

/**
 * Avisa o canal do Discord que há um pedido esperando decisão.
 *
 * Marca @everyone: foi o pedido do time, e é coerente com o resto do canal,
 * que já usa menção para o que precisa de ação humana.
 *
 * O id do pedido entra na mensagem de propósito — o notificador tem uma
 * janela de deduplicação de 60 segundos por conteúdo, e sem algo único dois
 * pedidos seguidos parecidos seriam engolidos.
 */
async function avisarDiscord(lote) {
  const lista = lote.dominios.slice(0, 12).map((d) => `• ${d.nome}`).join('\n');
  const resto = lote.dominios.length > 12 ? `\n• …e mais ${lote.dominios.length - 12}` : '';

  const linhas = [
    '🔒 **Pedido de exclusão aguardando aprovação**',
    '',
    `**Quem pediu:** ${lote.solicitanteNome}`,
    `**Domínios:** ${lote.dominios.length}`,
    lote.motivo ? `**Motivo:** ${lote.motivo}` : null,
    lote.origem === 'ritmo'
      ? '**Por quê:** terceira exclusão em menos de 20 minutos'
      : '**Por quê:** exclusão de dois ou mais domínios de uma vez',
    '',
    lista + resto,
    '',
    'Só um super admin pode aprovar, e quem pediu não pode aprovar o próprio pedido.',
    `Pedido \`${lote.id}\` · vence em 24 horas`,
  ].filter((l) => l !== null);

  try {
    await require('../notify/discord').send(linhas.join('\n'), { critico: true });
  } catch (e) {
    // O pedido já está gravado; falhar o aviso não pode desfazer isso.
    console.error('❌ [EXCLUSAO] Falha ao avisar o Discord:', e.message);
  }
}

module.exports = { verificar, registrar, avisarDiscord, idDoDominio };
