const axios = require('axios');
const config = require('../../config/env');

class WhatsAppService {
  constructor() {
    this.baseURL = `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}`;
  }

  /**
   * Verifica se um número está registrado no WhatsApp
   * @param {string} phoneNumber - Número de telefone no formato internacional (ex: 5519999999999)
   * @returns {Promise<boolean>}
   */
  async checkPhoneNumber(phoneNumber) {
    try {
      // Remove caracteres especiais
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      
      console.log('🔍 [ZAPI] Verificando número:', cleanNumber);
      console.log('🔗 [ZAPI] URL:', `${this.baseURL}/phone-exists`);
      
      const response = await axios.get(`${this.baseURL}/phone-exists`, {
        params: {
          phone: cleanNumber
        }
      });

      console.log('📥 [ZAPI] Resposta:', JSON.stringify(response.data, null, 2));

      const exists = response.data.exists === true;
      console.log(`${exists ? '✅' : '❌'} [ZAPI] Número ${cleanNumber}: ${exists ? 'EXISTE' : 'NÃO EXISTE'}`);

      return exists;
    } catch (error) {
      console.error('❌ [ZAPI] Erro ao verificar número:', error.message);
      if (error.response) {
        console.error('❌ [ZAPI] Status:', error.response.status);
        console.error('❌ [ZAPI] Dados:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Envia mensagem de texto via WhatsApp
   * @param {string} phoneNumber - Número de telefone no formato internacional
   * @param {string} message - Mensagem a ser enviada
   * @returns {Promise<object>}
   */
  async sendMessage(phoneNumber, message) {
    try {
      // Remove caracteres especiais
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      
      const response = await axios.post(`${this.baseURL}/send-text`, {
        phone: cleanNumber,
        message: message
      });

      return {
        success: true,
        messageId: response.data.messageId,
        data: response.data
      };
    } catch (error) {
      console.error('Erro ao enviar mensagem via WhatsApp:', error.message);
      return {
        success: false,
        error: error.message
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
  async sendSuspendedDomainAlert(phoneNumber, domainName, userName = 'Cliente') {
    const message = `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${userName}*, detectamos que o domínio *${domainName}* foi suspenso!

━━━━━━━━━━━━━━━━━━━━━

🔴 *Status:* SUSPENSO
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
    
    // Só envia se houver domínios críticos
    if (suspended === 0 && expired === 0 && expiringSoon === 0) {
      return {
        success: false,
        message: 'Nenhum domínio crítico para reportar'
      };
    }

    const total = suspended + expired + expiringSoon;

    const message = `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${userName}*, você tem *${total} domínio${total > 1 ? 's' : ''}* que precisa${total > 1 ? 'm' : ''} de atenção imediata!

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
  async sendExpiredDomainAlert(phoneNumber, domainName, userName = 'Cliente') {
    const message = `🤖 *DOMAIN HUB*

⚠️ *ALERTA URGENTE*

*${userName}*, o domínio *${domainName}* expirou!

━━━━━━━━━━━━━━━━━━━━━

🟠 *Status:* EXPIRADO
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