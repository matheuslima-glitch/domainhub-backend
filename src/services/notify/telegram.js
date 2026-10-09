// =====================================================
// CANAL DE NOTIFICAÇÃO — TELEGRAM
//
// TERCEIRO canal de saída, EM PARALELO com a Z-API e com o Discord — não no
// lugar de nenhum dos dois. Os três são independentes: um fora do ar não
// impede os outros.
//
// POR QUE ELE EXISTE
//
// O Discord parou de entregar: HTTP 401 com código 50027, que é "token de
// webhook inválido" — alguém apagou o webhook ou a URL mudou. O canal morreu
// por CONFIGURAÇÃO, e nada no sistema avisou; os alertas simplesmente deixaram
// de chegar.
//
// O Telegram não tem esse modo de falha. O token é do BOT, não de um webhook
// de canal: ele não expira quando alguém mexe nas configurações do grupo, e
// continua válido se o grupo for renomeado ou migrado para supergrupo.
//
// DEDUPLICAÇÃO — leia antes de mexer (mesma razão do Discord):
// O código de notificação foi escrito para WhatsApp, onde cada contato tem um
// número: ele percorre `notification_settings` e envia UMA mensagem POR
// CONTATO. Num grupo existe um destino só, então esse laço postaria a mesma
// mensagem N vezes seguidas. Como reescrever a lógica de contatos (1.618
// linhas, com regras de agendamento que funcionam) está fora de escopo, o
// canal colapsa mensagens idênticas numa janela curta.
//
// FORMATAÇÃO — a ordem importa:
// Escapamos HTML ANTES de converter *negrito* em <b>. Na ordem inversa, as
// próprias tags que acabamos de criar seriam escapadas e o grupo receberia
// "&lt;b&gt;" literal na tela.
// =====================================================

const axios = require('axios');
const config = require('../../config/env');

const REQUEST_TIMEOUT = 15000;
const JANELA_DEDUPE_MS = 60000;

// Telegram aceita 4096 caracteres por mensagem — o dobro do Discord. Alertas
// que o Discord truncava cabem inteiros aqui.
const LIMITE_TELEGRAM = 4096;

// POLÍTICA DO CANAL (decidida pelo Matheus em 09/10/2026)
//
// "Tudo exceto sucessos." O grupo recebe falha de domínio (caído, suspenso,
// expirado), erro de compra, erro de swap e pedido de exclusão. NÃO recebe
// compra concluída com êxito, swap concluído, boas-vindas de cadastro nem
// teste — quem chama marca essas com { critico: false } e elas param aqui.
//
// Ligar ENVIAR_INFORMATIVOS faz as informativas passarem SEM SOM
// (`disable_notification`), para o grupo virar histórico completo sem virar
// barulho. É o motivo de `disable_notification` existir abaixo mesmo hoje não
// tendo efeito: ele já está no lugar certo para quando a política mudar.
const ENVIAR_INFORMATIVOS = false;

class TelegramNotifier {
  constructor() {
    this.token = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.configured = !!(this.token && this.chatId);

    // chave normalizada -> timestamp do último envio
    this.enviadasRecentemente = new Map();

    if (!this.configured) {
      console.warn(
        '⚠️ [TELEGRAM] TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID não configurados - canal desabilitado'
      );
    }
  }

  get url() {
    return `https://api.telegram.org/bot${this.token}/sendMessage`;
  }

  /**
   * Confere a configuração no boot, SEM POSTAR NADA no grupo.
   *
   * `getMe` valida o token; `getChat` valida o chat_id e prova que o bot
   * enxerga o grupo. Juntas, as duas respondem "está configurado certo?" —
   * que antes só dava para descobrir esperando um domínio cair.
   *
   * Por que não mandar uma mensagem de teste: o boot acontece a cada deploy e
   * a cada reinício do Render. Um "oi" no grupo toda vez treinaria o time a
   * ignorar o canal, que é o oposto do que ele serve.
   *
   * Nunca lança: é diagnóstico, não pode impedir o servidor de subir.
   */
  async verificar() {
    if (!this.configured) {
      return { ok: false, erro: 'TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID ausentes' };
    }

    const chamar = async (metodo, params) => {
      const { data } = await axios.get(`https://api.telegram.org/bot${this.token}/${metodo}`, {
        params,
        timeout: REQUEST_TIMEOUT,
        validateStatus: () => true
      });
      if (!data || data.ok !== true) {
        throw new Error(
          this.explicar(
            (data && data.error_code) || 0,
            (data && data.description) || 'sem descrição',
            data && data.parameters
          )
        );
      }
      return data.result;
    };

    try {
      const bot = await chamar('getMe');
      const chat = await chamar('getChat', { chat_id: this.chatId });
      return {
        ok: true,
        bot: bot.username ? `@${bot.username}` : bot.first_name,
        grupo: chat.title || chat.username || String(this.chatId),
        tipo: chat.type
      };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  }

  /**
   * Escapa o que o parse_mode HTML do Telegram trataria como marcação.
   *
   * São exatamente três caracteres — `&` primeiro, senão ele reescaparia os
   * `&` que nós mesmos acabamos de inserir.
   */
  escaparHTML(texto) {
    return String(texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Converte a formatação das mensagens para a do Telegram (parse_mode HTML).
   *
   * DUAS CONVENÇÕES CONVIVEM NA BASE, e as duas precisam ser tratadas:
   *
   *   `*texto*`   — estilo WhatsApp, usado pelos templates de alerta
   *   `**texto**` — estilo Discord, usado pelo aviso de exclusão em lote
   *                 (services/exclusao/index.js escreve direto em markdown
   *                 do Discord, sem passar pelo WhatsApp)
   *
   * Tratar só uma delas faria a outra chegar literal: o grupo receberia
   * "**Quem pediu:**" com os asteriscos à mostra. O duplo vem primeiro —
   * depois dele não resta nenhum `**` para a segunda regra confundir.
   *
   * Backticks viram <code> porque o aviso de exclusão identifica o pedido com
   * `id` entre crases, e sem conversão as crases apareceriam na tela.
   *
   * Sublinhado vira itálico, mas SÓ FORA DE PALAVRA. A primeira versão disto
   * não convertia `_` nenhum, com medo de estragar `meu_dominio.com` — e aí o
   * rodapé dos templates chegou no grupo com os sublinhados à mostra
   * ("_Disparado em 09/10/2026_", visto em 09/10/2026).
   *
   * A guarda de borda resolve os dois lados: em `meu_dominio` o `_` tem letra
   * dos dois lados e não casa; em `_Disparado em ..._` ele está colado a
   * espaço ou quebra de linha e casa. Nome de domínio e identificador passam
   * intactos.
   *
   * Nenhuma regra atravessa quebra de linha, para não juntar dois trechos
   * distintos por engano — mesma regra do canal do Discord.
   */
  converterFormatacao(texto) {
    return this.escaparHTML(texto)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
      .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '<b>$1</b>')
      .replace(/`([^`\n]+?)`/g, '<code>$1</code>')
      .replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, '<i>$1</i>');
  }

  /**
   * Chave usada para detectar duplicata.
   *
   * QUEM ENVIA PODE DECLARAR A CHAVE, e deve sempre que souber: `chaveAlerta`
   * identifica o alerta por aquilo que ele É (tipo + domínio), não pelo texto
   * que saiu. É o único jeito confiável, porque os templates são
   * PERSONALIZADOS — "*Eduardo*, detectamos que o domínio *xpto.com* foi
   * suspenso" muda de contato para contato.
   *
   * Medido em 09/10/2026: 27 contatos ativos, 18 com número e 17 nomes
   * distintos. Sem a chave declarada, um único domínio suspenso encheria o
   * grupo com até 17 cópias — e o grupo seria silenciado pelo time, que é o
   * fim de qualquer canal de alerta.
   *
   * A NORMALIZAÇÃO DO TEXTO continua, como reserva para quem não declara:
   * os templates carimbam data e hora COM SEGUNDOS, e duas cópias enviadas
   * com um segundo de diferença seriam textos distintos.
   */
  chaveDedupe(message, opts = {}) {
    if (opts.chaveAlerta) return `#${opts.chaveAlerta}`;

    return String(message)
      .replace(/\d{2}:\d{2}(:\d{2})?/g, '')
      .replace(/\d{2}\/\d{2}\/\d{2,4}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  limparCacheAntigo(agora) {
    for (const [chave, quando] of this.enviadasRecentemente) {
      if (agora - quando > JANELA_DEDUPE_MS) this.enviadasRecentemente.delete(chave);
    }
  }

  /**
   * Traduz a falha da API para algo que diga o que fazer.
   *
   * As três que realmente acontecem têm causa e conserto distintos, e a
   * mensagem crua do Telegram ("Unauthorized") não diferencia nenhuma delas.
   */
  explicar(status, descricao, parametros) {
    if (status === 401) {
      return `token inválido (confira TELEGRAM_BOT_TOKEN) - ${descricao}`;
    }

    // O grupo virou SUPERGRUPO e o chat_id mudou.
    //
    // Acontece sozinho, sem ninguém pedir: o Telegram promove o grupo quando
    // ele passa de certo tamanho, ganha histórico visível ou recebe um
    // administrador novo. O id antigo para de funcionar na hora.
    //
    // É o modo de falha mais traiçoeiro deste canal, porque ninguém "mexeu em
    // nada". O id novo vem na própria resposta — então o log diz exatamente o
    // que colar no Render, em vez de mandar caçar no getUpdates.
    const novoId = parametros && parametros.migrate_to_chat_id;
    if (novoId) {
      return `o grupo virou supergrupo e o chat_id mudou. Troque TELEGRAM_CHAT_ID para ${novoId} no Render - ${descricao}`;
    }

    if (status === 400 && /chat not found/i.test(descricao)) {
      return `chat não encontrado: o bot precisa estar NO grupo e o TELEGRAM_CHAT_ID ser o do grupo (negativo) - ${descricao}`;
    }
    if (status === 403) {
      return `bot sem permissão de postar no grupo (foi removido ou está restrito) - ${descricao}`;
    }
    return `HTTP ${status} - ${descricao}`;
  }

  /**
   * Envia uma mensagem ao grupo.
   *
   * @param {string} message
   * @param {object} [opts]
   * @param {boolean} [opts.critico=true] - false para informativa (sucesso,
   *        boas-vindas, teste). O padrão é crítico: se alguém esquecer de
   *        marcar, o alerta chega — preferimos ruído a silêncio.
   * @param {{rotulo: string, url: string}} [opts.botao] - botão de link.
   *
   * Devolve { success, error }, o mesmo formato do Discord e do WhatsApp, para
   * quem chama não precisar distinguir os canais.
   */
  async send(message, opts = {}) {
    const { critico = true } = opts;

    if (!critico && !ENVIAR_INFORMATIVOS) {
      console.log('🔕 [TELEGRAM] Mensagem informativa não enviada (canal recebe tudo exceto sucessos)');
      return { success: true, suprimida: true };
    }

    if (!this.configured) {
      return { success: false, error: 'Telegram não configurado' };
    }

    if (!message || !String(message).trim()) {
      return { success: false, error: 'Mensagem vazia' };
    }

    const agora = Date.now();
    this.limparCacheAntigo(agora);

    const chave = this.chaveDedupe(message, opts);
    const jaEnviada = this.enviadasRecentemente.get(chave);
    if (jaEnviada && agora - jaEnviada < JANELA_DEDUPE_MS) {
      console.log('🔁 [TELEGRAM] Mesmo alerta já enviado há pouco - ignorando duplicata');
      return { success: true, deduplicated: true };
    }

    let texto = this.converterFormatacao(message);

    if (texto.length > LIMITE_TELEGRAM) {
      // Corta com folga e fecha qualquer <b> aberto pelo corte: tag
      // desbalanceada faz o Telegram RECUSAR a mensagem inteira com HTTP 400,
      // e aí o alerta não chega de jeito nenhum.
      texto = texto.slice(0, LIMITE_TELEGRAM - 40);
      const abertas = (texto.match(/<b>/g) || []).length;
      const fechadas = (texto.match(/<\/b>/g) || []).length;
      if (abertas > fechadas) texto += '</b>';
      texto += '\n… (truncado)';
      console.warn(`⚠️ [TELEGRAM] Mensagem excedeu ${LIMITE_TELEGRAM} caracteres e foi truncada`);
    }

    const corpo = {
      chat_id: this.chatId,
      text: texto,
      parse_mode: 'HTML',
      // Informativa (quando ligada) chega sem som; falha sempre notifica.
      disable_notification: !critico,
      // Alertas costumam citar domínios; a prévia do link roubaria a tela.
      link_preview_options: { is_disabled: true }
    };

    if (opts.botao && opts.botao.url && opts.botao.rotulo) {
      corpo.reply_markup = {
        inline_keyboard: [[{ text: opts.botao.rotulo, url: opts.botao.url }]]
      };
    }

    try {
      console.log(`📤 [TELEGRAM] Enviando: ${message.replace(/\n/g, ' ').substring(0, 60)}...`);

      const { data } = await axios.post(this.url, corpo, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'Content-Type': 'application/json' },
        // O Telegram devolve 4xx COM corpo explicando. Sem isto o axios lança
        // e a explicação se perde no stack.
        validateStatus: () => true
      });

      if (!data || data.ok !== true) {
        const detalhe = this.explicar(
          (data && data.error_code) || 0,
          (data && data.description) || 'sem descrição',
          data && data.parameters
        );
        console.error(`❌ [TELEGRAM] Falha ao enviar: ${detalhe}`);
        return { success: false, error: detalhe };
      }

      this.enviadasRecentemente.set(chave, agora);
      console.log('✅ [TELEGRAM] Mensagem enviada');

      return { success: true, messageId: data.result && data.result.message_id };
    } catch (error) {
      const detalhe = error.response
        ? this.explicar(error.response.status, JSON.stringify(error.response.data))
        : error.message;

      console.error(`❌ [TELEGRAM] Falha ao enviar: ${detalhe}`);
      return { success: false, error: detalhe };
    }
  }
}

module.exports = new TelegramNotifier();
