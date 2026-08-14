// =====================================================
// CANAL DE NOTIFICAÇÃO — DISCORD
//
// Substitui a Z-API como canal de saída dos alertas. Antes existiam QUATRO
// pontos independentes falando com a Z-API (o serviço oficial e mais três
// dentro dos fluxos de compra/swap), cada um com seu próprio axios.post.
// Todos passam a sair por aqui.
//
// DEDUPLICAÇÃO — leia antes de mexer:
// O código de notificação foi escrito para WhatsApp, onde cada contato tem um
// número próprio: ele percorre `notification_settings` e envia UMA mensagem POR
// CONTATO. No Discord existe um canal só, então esse laço postaria a mesma
// mensagem N vezes seguidas.
//
// Em vez de reescrever a lógica de contatos (1.600+ linhas, com regras de
// agendamento e permissão que funcionam), o canal colapsa mensagens idênticas
// enviadas dentro de uma janela curta. Dois domínios diferentes geram textos
// diferentes e ambos passam; o mesmo domínio para 5 contatos vira 1 mensagem.
// =====================================================

const axios = require('axios');
const config = require('../../config/env');

const REQUEST_TIMEOUT = 15000;
const JANELA_DEDUPE_MS = 60000;
const LIMITE_DISCORD = 2000;

// POLITICA DO CANAL (definida pelo time)
//
// O canal recebe SOMENTE falhas: dominio caido, suspenso, expirado, erro de
// compra e erro de swap. Todas marcam @everyone.
//
// Mensagens informativas - compra concluida com sucesso, swap concluido,
// boas-vindas de cadastro e testes - NAO sao enviadas. Quem chama marca com
// { critico: false } e elas param aqui.
//
// Para voltar a receber as informativas em silencio (sem mencao), basta
// ligar ENVIAR_INFORMATIVOS: elas passam a chegar sem @everyone.
const ENVIAR_INFORMATIVOS = false;
const PREFIXO_MENCAO = '@everyone';

class DiscordNotifier {
  constructor() {
    this.webhookUrl = config.DISCORD_WEBHOOK_URL;
    this.configured = !!this.webhookUrl;

    // mensagem -> timestamp do último envio
    this.enviadasRecentemente = new Map();

    if (!this.configured) {
      console.warn('⚠️ [DISCORD] DISCORD_WEBHOOK_URL não configurada - notificações desabilitadas');
    }
  }

  /**
   * Converte a formatação do WhatsApp para a do Discord.
   *
   * No WhatsApp *texto* é negrito; no Discord isso é itálico — negrito é **texto**.
   * O itálico _texto_ funciona igual nos dois, então não precisa de conversão.
   *
   * A regex ignora asteriscos já duplicados e não atravessa quebras de linha,
   * para não juntar dois trechos distintos por engano.
   */
  converterFormatacao(texto) {
    return String(texto).replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '**$1**');
  }

  /**
   * Chave usada para detectar duplicata.
   *
   * Não dá para comparar a mensagem crua: todos os templates carimbam data e
   * hora COM SEGUNDOS ("Detectado em: 30/04/2026, 09:11:44"). Duas cópias do
   * mesmo alerta, enviadas para contatos diferentes com um segundo de diferença,
   * seriam textos distintos e passariam as duas.
   *
   * Removendo data e hora, o que sobra é o conteúdo real do alerta — que é o que
   * define se é a mesma notificação ou não.
   */
  chaveDedupe(message) {
    return String(message)
      .replace(/\d{2}:\d{2}(:\d{2})?/g, '')
      .replace(/\d{2}\/\d{2}\/\d{2,4}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Remove entradas velhas do cache de deduplicação para não crescer sem fim.
   */
  limparCacheAntigo(agora) {
    for (const [chave, quando] of this.enviadasRecentemente) {
      if (agora - quando > JANELA_DEDUPE_MS) this.enviadasRecentemente.delete(chave);
    }
  }

  /**
   * Envia uma mensagem ao canal.
   *
   * @param {string} message
   * @param {object} [opts]
   * @param {boolean} [opts.critico=true] - false para mensagens informativas
   *        (sucesso, boas-vindas, teste). O padrão é crítico: se alguém
   *        esquecer de marcar, o alerta chega — preferimos ruído a silêncio.
   *
   * Devolve o mesmo formato do serviço de WhatsApp ({ success, error }) para que
   * quem chama continue funcionando sem alteração.
   */
  async send(message, opts = {}) {
    const { critico = true } = opts;

    if (!critico && !ENVIAR_INFORMATIVOS) {
      console.log('🔕 [DISCORD] Mensagem informativa não enviada (canal recebe só falhas)');
      return { success: true, suprimida: true };
    }

    if (!this.configured) {
      return { success: false, error: 'Discord não configurado' };
    }

    if (!message || !String(message).trim()) {
      return { success: false, error: 'Mensagem vazia' };
    }

    const agora = Date.now();
    this.limparCacheAntigo(agora);

    const chave = this.chaveDedupe(message);
    const jaEnviada = this.enviadasRecentemente.get(chave);
    if (jaEnviada && agora - jaEnviada < JANELA_DEDUPE_MS) {
      console.log('🔁 [DISCORD] Mesmo alerta já enviado há pouco - ignorando duplicata');
      return { success: true, deduplicated: true };
    }

    let conteudo = this.converterFormatacao(message);

    // A mencao entra ANTES do truncamento para nunca ser cortada
    const prefixo = critico ? `${PREFIXO_MENCAO}\n` : '';
    const limiteTexto = LIMITE_DISCORD - prefixo.length;

    if (conteudo.length > limiteTexto) {
      conteudo = `${conteudo.slice(0, limiteTexto - 20)}\n… (truncado)`;
      console.warn(`⚠️ [DISCORD] Mensagem excedeu ${LIMITE_DISCORD} caracteres e foi truncada`);
    }

    conteudo = prefixo + conteudo;

    try {
      console.log(`📤 [DISCORD] Enviando: ${conteudo.replace(/\n/g, ' ').substring(0, 60)}...`);

      await axios.post(
        this.webhookUrl,
        {
          username: 'DomainHub',
          content: conteudo,
          // Sem isto o Discord pode ignorar o @everyone vindo de webhook
          allowed_mentions: { parse: ['everyone'] }
        },
        { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } }
      );

      this.enviadasRecentemente.set(chave, agora);
      console.log('✅ [DISCORD] Mensagem enviada');

      return { success: true };
    } catch (error) {
      const detalhe = error.response
        ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
        : error.message;

      console.error(`❌ [DISCORD] Falha ao enviar: ${detalhe}`);
      return { success: false, error: detalhe };
    }
  }
}

module.exports = new DiscordNotifier();
