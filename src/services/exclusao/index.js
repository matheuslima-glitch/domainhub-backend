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
 * O QUE ACONTECE QUANDO NÃO DÁ PARA VERIFICAR
 *
 * Barra. Banco fora, usuário não identificado, domínio fora da base: a
 * exclusão é recusada. É preferível a equipe ficar sem excluir durante uma
 * instabilidade a um domínio sair do ar sem a aprovação que a regra exige.
 *
 * A exceção é a trava não estar instalada no banco — aí libera, porque é o
 * estado esperado entre mesclar este código e rodar a migration.
 *
 * COMO DESLIGAR SEM DEPLOY
 *
 * EXCLUSAO_EXIGE_APROVACAO=false no Render. A verificação passa a devolver
 * "permitido" sempre, e o registro continua acontecendo — assim o histórico
 * não fica com buraco durante o período desligado. É também a saída quando a
 * trava barrar por engano e a operação não puder esperar.
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
 * A trava não está instalada?
 *
 * Distingue "a migration ainda não rodou" de "o banco está com problema".
 * São situações opostas: a primeira é o estado normal antes da instalação e
 * deve deixar tudo funcionar como antes; a segunda é falha e deve barrar.
 *
 * Sem essa distinção, mesclar o backend antes de rodar a migration pararia
 * toda exclusão do painel.
 */
function travaNaoInstalada(error) {
  const codigo = String(error.code || '');
  const msg = String(error.message || '').toLowerCase();
  return (
    codigo === 'PGRST202' ||            // PostgREST: função não encontrada no schema
    codigo === '42883' ||               // Postgres: undefined_function
    msg.includes('could not find the function') ||
    msg.includes('does not exist')
  );
}

/**
 * Pergunta se esta pessoa pode excluir este domínio agora.
 *
 * BARRA quando não consegue verificar — decidido com o time em 29/09/2026.
 * Banco fora, usuário não identificado, domínio que não está na base: em
 * qualquer um desses a exclusão é recusada.
 *
 * O raciocínio: é preferível a equipe ficar sem excluir durante uma
 * instabilidade a um domínio sair do ar sem a aprovação que a regra exige.
 * Quando isso atrapalhar de verdade, a saída é EXCLUSAO_EXIGE_APROVACAO=false
 * no Render — um restart, sem deploy.
 *
 * A única exceção é a trava não estar instalada. Aí não há falha nenhuma: é
 * o estado esperado entre mesclar o backend e rodar a migration, e barrar
 * nessa janela pararia a operação por um motivo que não é risco.
 */
async function verificar({ domainId, domainName, userId }) {
  if (!config.EXCLUSAO_EXIGE_APROVACAO) {
    return { permitido: true, motivo: 'trava_desligada' };
  }

  if (!userId) {
    // Chegar aqui significa que alguma rota perdeu o middleware de auth.
    console.error('❌ [EXCLUSAO] Chamada sem usuário identificado — exclusão barrada');
    return {
      permitido: false,
      motivo: 'sem_usuario',
      mensagem: 'Não foi possível identificar quem está pedindo a exclusão. Entre novamente no painel.',
    };
  }

  const id = domainId || (domainName ? await idDoDominio(domainName) : null);
  if (!id) {
    console.error(`❌ [EXCLUSAO] Domínio não encontrado na base (${domainName || domainId}) — exclusão barrada`);
    return {
      permitido: false,
      motivo: 'dominio_desconhecido',
      mensagem:
        'Este domínio não está cadastrado na base, então a trava não consegue verificá-lo. ' +
        'Se for uma limpeza de resto órfão, peça a um super admin.',
    };
  }

  const { data, error } = await supabase.rpc('pode_excluir_dominio', {
    p_domain_id: id,
    p_user_id: userId,
  });

  if (error) {
    if (travaNaoInstalada(error)) {
      console.warn('⚠️ [EXCLUSAO] Trava ainda não instalada no banco — rode a migration de 29/09');
      return { permitido: true, motivo: 'trava_nao_instalada' };
    }
    console.error('❌ [EXCLUSAO] Falha ao consultar a trava — exclusão barrada:', error.message);
    return {
      permitido: false,
      motivo: 'erro_na_trava',
      erro: error.message,
      mensagem:
        'Não foi possível verificar a permissão de exclusão agora. ' +
        'Tente de novo em alguns minutos; se persistir, avise a infraestrutura.',
    };
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
 * O botão leva para a tela de aprovação NO PAINEL, e não aprova por si.
 * A mensagem chega com @everyone, ou seja, todo o canal a vê: um botão que
 * aprovasse sozinho entregaria a decisão para qualquer um que clicasse,
 * inclusive para quem pediu a exclusão. Abrindo o painel, quem decide
 * precisa estar logado e ser super admin, e a decisão fica no nome dele.
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

  // Sem PAINEL_URL o aviso sai sem botão, identificado pelo id. Melhor isso
  // do que um botão que leva a lugar nenhum.
  const botao = config.PAINEL_URL
    ? { rotulo: 'Aprovar no painel', url: `${config.PAINEL_URL}/aprovacoes/${lote.id}` }
    : null;

  try {
    await require('../notify/discord').send(linhas.join('\n'), { critico: true, botao });
  } catch (e) {
    // O pedido já está gravado; falhar o aviso não pode desfazer isso.
    console.error('❌ [EXCLUSAO] Falha ao avisar o Discord:', e.message);
  }
}

module.exports = { verificar, registrar, avisarDiscord, idDoDominio };
