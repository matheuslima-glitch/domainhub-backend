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
   * Envia mensagem de texto via WhatsApp
   * @param {string} phoneNumber - Número de telefone no formato internacional
   * @param {string} message - Mensagem a ser enviada
   * @returns {Promise<object>}
   */
  async sendMessage(phoneNumber, message) {
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
   * Envia alerta imediato de domínio suspenso
   * @param {string} phoneNumber - Número de telefone
   * @param {string} domainName - Nome do domínio
   * @param {string} userName - Nome do usuário
   * @returns {Promise<object>}
   */
  async sendSuspendedDomainAlert(phoneNumber, domainName, userName = 'Cliente', monthlyVisits = 0, trafficSource = null) {
    const firstName = this.getFirstName(userName);
    const visitsFormatted = monthlyVisits ? monthlyVisits.toLocaleString('pt-BR') + ' acessos/mês' : 'Nenhum acesso mensal';
    const sourceFormatted = trafficSource || 'Não definido';
    
    const message = `🤖 *DOMAIN HUB*

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

    return this.sendMessage(phoneNumber, message);
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

    return this.sendMessage(phoneNumber, message);
  }

  /**
   * Envia alerta imediato de domínio expirado
   * @param {string} phoneNumber - Número de telefone
   * @param {string} domainName - Nome do domínio
   * @param {string} userName - Nome do usuário
   * @returns {Promise<object>}
   */
  async sendExpiredDomainAlert(phoneNumber, domainName, userName = 'Cliente', monthlyVisits = 0, trafficSource = null, weeklyVisits = 0) {
    const firstName = this.getFirstName(userName);
    const visitsFormatted = monthlyVisits ? monthlyVisits.toLocaleString('pt-BR') + ' acessos/mês' : 'Nenhum acesso mensal';
    const weeklyFormatted = weeklyVisits ? weeklyVisits.toLocaleString('pt-BR') + ' acessos (últimos 7 dias)' : 'Nenhum acesso nos últimos 7 dias';
    const sourceFormatted = trafficSource || 'Não definido';
    
    const message = `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${firstName}*, o domínio *${domainName}* expirou!

━━━━━━━━━━━━━━━━━━━━━

🟠 *Status:* EXPIRADO
📊 *Acessos:* ${visitsFormatted}
📈 *Últimos 7 dias:* ${weeklyFormatted}
📢 *Fonte:* ${sourceFormatted}
⏰ *Detectado em:* ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

━━━━━━━━━━━━━━━━━━━━━

📋 *Ação necessária:*

• Renove o domínio o mais rápido possível
• Verifique o período de carência disponível
• Acesse sua tabela de gestão de domínios críticos

━━━━━━━━━━━━━━━━━━━━━

⚡ *Acesse o Domain Hub para mais detalhes*`;

    return this.sendMessage(phoneNumber, message);
  }
}

module.exports = new WhatsAppService();
