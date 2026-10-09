const axios = require('axios');
const config = require('../../config/env');

class WhatsAppService {
  constructor() {
    // Validar configuração ZAPI
    if (!config.ZAPI_INSTANCE || !config.ZAPI_CLIENT_TOKEN) {
      console.log('⚠️ [ZAPI] Configuração não encontrada - notificações WhatsApp desabilitadas');
      this.configured = false;
      return;
    }

    // Usar URL diretamente (mesmo padrão do código de compra)
    this.zapiUrl = config.ZAPI_INSTANCE;
    this.clientToken = config.ZAPI_CLIENT_TOKEN;
    this.configured = true;

    console.log('✅ [ZAPI] Configurado e pronto');
  }

  /**
   * Mascara número de telefone para logs
   * Exemplo: 5519999999999 -> 5519****9999
   */
  maskPhone(phone) {
    if (!phone) return '***';
    const clean = phone.replace(/\D/g, '');
    if (clean.length < 8) return '***';
    return clean.substring(0, 4) + '****' + clean.substring(clean.length - 4);
  }

  /**
   * Extrai primeiro nome
   * Exemplo: "João Silva Santos" -> "João"
   */
  getFirstName(fullName) {
    if (!fullName) return 'Cliente';
    return fullName.trim().split(' ')[0];
  }

  /**
   * Verifica se um número está registrado no WhatsApp
   * @param {string} phoneNumber - Número de telefone no formato internacional
   * @returns {Promise<boolean>}
   */
  async checkPhoneNumber(phoneNumber) {
    if (!this.configured) {
      throw new Error('ZAPI não configurado');
    }

    try {
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      console.log('🔍 [ZAPI] Verificando número:', this.maskPhone(cleanNumber));

      // Endpoint correto: /phone-exists/{numero} - número na URL, não como param
      const baseUrl = this.zapiUrl.replace('/send-text', '');
      const checkUrl = `${baseUrl}/phone-exists/${cleanNumber}`;
      
      console.log('🔍 [ZAPI] URL de verificação:', checkUrl.replace(cleanNumber, '***'));

      const response = await axios.get(checkUrl, {
        headers: {
          'Client-Token': this.clientToken,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      console.log('🔍 [ZAPI] Resposta:', JSON.stringify(response.data));

      // A Z-API retorna { exists: true/false } ou pode retornar como string "true"/"false"
      const exists = response.data.exists === true || response.data.exists === 'true' || response.data.isRegistered === true;
      console.log(`${exists ? '✅' : '❌'} [ZAPI] Número ${exists ? 'existe' : 'não existe'}`);

      return exists;
    } catch (error) {
      console.error('❌ [ZAPI] Erro ao verificar número:', error.message);
      if (error.response) {
        console.error('❌ [ZAPI] Status:', error.response.status);
        console.error('❌ [ZAPI] Data:', JSON.stringify(error.response.data));
      }
      // Em caso de erro, assumir que existe (para não bloquear)
      return true;
    }
  }

  /**
   * Espelha a mensagem nos canais paralelos: Discord e Telegram.
   *
   * ACRÉSCIMO — não interfere no envio da Z-API. É disparado sem `await` de
   * propósito: o tempo de resposta e o valor devolvido por sendMessage()
   * continuam exatamente os mesmos de antes. Qualquer erro dos canais morre
   * dentro do distribuidor e nunca sobe para quem chamou.
   *
   * Os canais colapsam mensagens iguais numa janela curta, então o laço que
   * percorre os contatos do WhatsApp — uma mensagem por contato — resulta em
   * uma única mensagem em cada grupo. Ver services/notify/.
   */
  espelharNosCanais(message, opts = {}) {
    // `naoEspelhar` é para quem JÁ mandou aos grupos por fora e agora está
    // percorrendo contatos de WhatsApp. Sem ele, o laço postaria uma vez por
    // pessoa. Ver sendSuspendedDomainAlert em whatsapp/notifications.js.
    if (opts.naoEspelhar) return;

    try {
      require('../notify').espelharEmSegundoPlano(message, opts);
    } catch (e) {
      console.error('❌ [NOTIFY] Falha ao carregar o distribuidor:', e.message);
    }
  }

  /**
   * Envia mensagem de texto via WhatsApp
   * @param {string} phoneNumber - Número de telefone no formato internacional
   * @param {string} message - Mensagem a ser enviada
   * @param {object} [opts] - Só para o Discord: { critico: false } em mensagem
   *        informativa (boas-vindas, teste). Ignorado pelo envio do WhatsApp.
   * @returns {Promise<object>}
   */
  async sendMessage(phoneNumber, message, opts = {}) {
    // Antes do guard da Z-API: assim os outros canais recebem o alerta mesmo
    // que a Z-API esteja fora de operação, que foi o cenário que os motivou.
    this.espelharNosCanais(message, opts);

    if (!this.configured) {
      return {
        success: false,
        error: 'ZAPI não configurado'
      };
    }

    try {
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      
      console.log('📤 [ZAPI] Enviando mensagem');
      console.log('📤 [ZAPI] Destinatário:', this.maskPhone(cleanNumber));
      console.log('📤 [ZAPI] Preview:', message.substring(0, 50) + '...');

      const response = await axios.post(
        this.zapiUrl,
        { 
          phone: cleanNumber,
          message: message 
        },
        { 
          timeout: 15000,
          headers: {
            'Client-Token': this.clientToken,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ [ZAPI] Mensagem enviada com sucesso');

      return {
        success: true,
        messageId: response.data.zapiMessageId || response.data.messageId,
        data: response.data
      };
    } catch (error) {
      console.error('❌ [ZAPI] Erro ao enviar mensagem:', error.message);
      
      if (error.response) {
        console.error('❌ [ZAPI] Status:', error.response.status);
        console.error('❌ [ZAPI] Erro:', error.response.data?.error || error.response.statusText);
      }

      return {
        success: false,
        error: error.message,
        statusCode: error.response?.status,
        details: error.response?.data
      };
    }
  }

  /**
   * MONTA o texto do alerta de domínio suspenso, sem enviar.
   *
   * Separado do envio para o alerta do GRUPO não depender de haver contato de
   * WhatsApp. Antes, o texto só existia dentro do laço que percorre
   * `notification_settings` — então sem contato com telefone, nada era
   * montado e o Discord e o Telegram não recebiam nada.
   *
   * Ver `sendSuspendedDomainAlert` em services/whatsapp/notifications.js, que
   * chama isto UMA vez para os canais de grupo e depois percorre os contatos.
   */
  /**
   * O tráfego do domínio, preferindo o dado VIVO.
   *
   * `requests_30d` é reescrita todo dia pelo coletor da Cloudflare.
   * `monthly_visits` é a importação CONGELADA de 15/08/2026 — nada no backend
   * escreve nela desde então (confirmado em 09/10/2026: nenhuma atribuição em
   * todo o `src/`).
   *
   * A diferença não é detalhe. Medido no mesmo domínio, com sete minutos entre
   * as duas mensagens: o relatório de críticos mostrou `mygelagen.com` com
   * 14.087.417 req/30d e o alerta de suspensão, 27.721 acessos/mês. **508
   * vezes.** Quem lesse o alerta concluiria que é um site pequeno e deixaria
   * para depois, que é o oposto do que o alerta serve.
   *
   * A reserva continua existindo porque domínio sem zona na Cloudflare tem
   * `requests_30d` nula — e ali o dado velho é melhor que nada. Mas vai
   * ROTULADO como velho: número sem procedência é pior que número ausente.
   */
  formatarTrafego(requests30d, monthlyVisits) {
    if (requests30d != null) {
      return Number(requests30d).toLocaleString('pt-BR') + ' requisições em 30 dias';
    }
    if (monthlyVisits) {
      return Number(monthlyVisits).toLocaleString('pt-BR') + ' acessos/mês (dado congelado em ago/2026)';
    }
    return 'Sem medição';
  }

  montarAlertaSuspenso(domainName, userName = 'Cliente', monthlyVisits = 0, trafficSource = null, requests30d = null) {
    const firstName = this.getFirstName(userName);
    const visitsFormatted = this.formatarTrafego(requests30d, monthlyVisits);
    const sourceFormatted = trafficSource || 'Não definido';

    return `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${firstName}*, detectamos que o domínio *${domainName}* foi suspenso!

━━━━━━━━━━━━━━━━━━━━━

🔴 *Status:* SUSPENSO
📊 *Acessos:* ${visitsFormatted}
📢 *Fonte:* ${sourceFormatted}
⏰ *Detectado em:* ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

━━━━━━━━━━━━━━━━━━━━━

📋 *Ação necessária:*

• Verifique sua tabela de gestão de domínios críticos
• Entre em contato com o registrador
• Revise suas configurações de pagamento

━━━━━━━━━━━━━━━━━━━━━

⚡ *Acesse o Domain Hub para mais detalhes*`;
  }

  /**
   * Envia alerta imediato de domínio suspenso a UM número de WhatsApp.
   *
   * @param {object} [opts] - repassado ao envio. Quem percorre contatos manda
   *        `{ naoEspelhar: true }`: os canais de grupo já receberam a sua
   *        cópia antes do laço, e espelhar de novo aqui postaria uma vez por
   *        contato.
   */
  async sendSuspendedDomainAlert(phoneNumber, domainName, userName = 'Cliente', monthlyVisits = 0, trafficSource = null, opts = {}) {
    const message = this.montarAlertaSuspenso(
      domainName, userName, monthlyVisits, trafficSource, opts.requests30d ?? null
    );

    // `chaveAlerta` identifica o alerta pelo que ele É, não pelo texto. Fica
    // como defesa: se alguém remover o `naoEspelhar` do laço, a chave ainda
    // impede que 17 nomes distintos virem 17 mensagens no grupo.
    return this.sendMessage(phoneNumber, message, {
      chaveAlerta: `suspenso:${domainName}`,
      ...opts
    });
  }

  /**
   * Envia relatório de domínios críticos
   * @param {string} phoneNumber - Número de telefone
   * @param {string} userName - Nome do usuário
   * @param {object} stats - Estatísticas dos domínios
   * @returns {Promise<object>}
   */
  async sendCriticalDomainsReport(phoneNumber, userName, stats) {
    const { suspended = 0, expired = 0, expiringSoon = 0 } = stats;
    
    if (suspended === 0 && expired === 0 && expiringSoon === 0) {
      return {
        success: false,
        message: 'Nenhum domínio crítico para reportar'
      };
    }

    const firstName = this.getFirstName(userName);
    const total = suspended + expired + expiringSoon;

    const message = `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${firstName}*, você tem *${total} domínio${total > 1 ? 's' : ''}* que precisa${total > 1 ? 'm' : ''} de atenção imediata!

━━━━━━━━━━━━━━━━━━━━━

${suspended > 0 ? `🔴 *${suspended} Domínio${suspended > 1 ? 's' : ''} Suspenso${suspended > 1 ? 's' : ''}*
   Requer ação imediata\n` : ''}${expired > 0 ? `🟠 *${expired} Domínio${expired > 1 ? 's' : ''} Expirado${expired > 1 ? 's' : ''}*
   Requer renovação urgente\n` : ''}${expiringSoon > 0 ? `🟡 *${expiringSoon} Domínio${expiringSoon > 1 ? 's' : ''} Próximo${expiringSoon > 1 ? 's' : ''} a Expirar*
   Expira${expiringSoon > 1 ? 'm' : ''} em 15 dias\n` : ''}
━━━━━━━━━━━━━━━━━━━━━

⚠️ *Possíveis consequências:*

• Perda de tráfego e visitantes
• Interrupção das campanhas de marketing
• Perda de receita imediata
• Risco de perder o domínio permanentemente

━━━━━━━━━━━━━━━━━━━━━

⚡ *Verifique AGORA na Gestão de Domínios Críticos* e tome ação imediata!

🕐 _Relatório gerado em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`;

    // O relatório é o mesmo para todo mundo numa dada rodada; o que muda é o
    // nome de quem recebe. O total entra na chave para que uma mudança real no
    // quadro gere um aviso novo em vez de ser engolida como duplicata.
    return this.sendMessage(phoneNumber, message, { chaveAlerta: `criticos:${total}` });
  }

  /**
   * Envia alerta imediato de domínio expirado
   * @param {string} phoneNumber - Número de telefone
   * @param {string} domainName - Nome do domínio
   * @param {string} userName - Nome do usuário
   * @returns {Promise<object>}
   */
  /** MONTA o texto do alerta de expirado, sem enviar. Ver `montarAlertaSuspenso`. */
  /**
   * @param {number|null} requests7d - soma VIVA dos últimos 7 dias, de
   *        `domain_daily_stats`. Substituiu `weekly_visits`, que era a mentira
   *        mais direta do sistema: um campo rotulado "últimos 7 dias"
   *        mostrando dado congelado em agosto. `null` quando o domínio não tem
   *        série diária — e aí a linha some, em vez de mostrar zero.
   */
  montarAlertaExpirado(domainName, userName = 'Cliente', monthlyVisits = 0, trafficSource = null, requests7d = null, requests30d = null) {
    const firstName = this.getFirstName(userName);
    const visitsFormatted = this.formatarTrafego(requests30d, monthlyVisits);
    const sourceFormatted = trafficSource || 'Não definido';

    // Sem série diária, a linha inteira sai do alerta. Escrever "Nenhum acesso
    // nos últimos 7 dias" para um domínio que simplesmente não é medido
    // afirmaria algo falso sobre ele.
    const linha7d =
      requests7d == null
        ? ''
        : `\n📈 *Últimos 7 dias:* ${Number(requests7d).toLocaleString('pt-BR')} requisições`;

    return `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${firstName}*, o domínio *${domainName}* expirou!

━━━━━━━━━━━━━━━━━━━━━

🟠 *Status:* EXPIRADO
📊 *Acessos:* ${visitsFormatted}${linha7d}
📢 *Fonte:* ${sourceFormatted}
⏰ *Detectado em:* ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

━━━━━━━━━━━━━━━━━━━━━

📋 *Ação necessária:*

• Renove o domínio o mais rápido possível
• Verifique o período de carência disponível
• Acesse sua tabela de gestão de domínios críticos

━━━━━━━━━━━━━━━━━━━━━

⚡ *Acesse o Domain Hub para mais detalhes*`;
  }

  /** Envia o alerta de expirado a UM número. Ver `sendSuspendedDomainAlert`. */
  async sendExpiredDomainAlert(phoneNumber, domainName, userName = 'Cliente', monthlyVisits = 0, trafficSource = null, opts = {}) {
    const message = this.montarAlertaExpirado(
      domainName, userName, monthlyVisits, trafficSource,
      opts.requests7d ?? null, opts.requests30d ?? null
    );

    return this.sendMessage(phoneNumber, message, {
      chaveAlerta: `expirado:${domainName}`,
      ...opts
    });
  }
}

module.exports = new WhatsAppService();
