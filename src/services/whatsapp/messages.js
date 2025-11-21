const axios = require('axios');
const config = require('../../config/env');

class WhatsAppService {
  constructor() {
    // Detectar formato das variáveis ZAPI
    if (config.ZAPI_INSTANCE && config.ZAPI_INSTANCE.includes('http')) {
      // Formato customizado: ZAPI_INSTANCE é uma URL completa
      // Exemplo: https://api.z-api.io/instances/XXX/token/YYY/send-text
      
      // Extrair a base URL até /token/XXX (remover tudo depois do primeiro /token/...)
      const parts = config.ZAPI_INSTANCE.split('/token/');
      const baseWithInstance = parts[0]; // https://api.z-api.io/instances/XXX
      
      // Reconstruir URL com o token correto
      this.baseURL = `${baseWithInstance}/token/${config.ZAPI_CLIENT_TOKEN}`;
      
      console.log('🔧 [ZAPI] Modo: URL Customizada');
      console.log('🔗 [ZAPI] Base URL configurada:', this.baseURL.replace(/token\/[^/]+/, 'token/***'));
    } else {
      // Formato padrão: ZAPI_INSTANCE é apenas o ID
      this.baseURL = `https://api.z-api.io/instances/${config.ZAPI_INSTANCE}/token/${config.ZAPI_CLIENT_TOKEN}`;
      
      console.log('🔧 [ZAPI] Modo: ID Padrão');
      console.log('🔗 [ZAPI] Base URL configurada:', this.baseURL.replace(/token\/[^/]+/, 'token/***'));
    }
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

      // Lista de endpoints possíveis da Z-API (tentar em ordem)
      const endpoints = [
        { method: 'GET', path: '/phone-exists', param: 'phone' },
        { method: 'POST', path: '/check-phone-number', body: true },
        { method: 'GET', path: '/check-number-status', param: 'phone' },
        { method: 'POST', path: '/phone-exists', body: true },
        { method: 'GET', path: '/phone', param: 'phone' }
      ];

      let lastError = null;

      // Tentar cada endpoint até encontrar um que funcione
      for (const endpoint of endpoints) {
        try {
          const url = `${this.baseURL}${endpoint.path}`;
          console.log(`🔗 [ZAPI] Tentando: ${endpoint.method} ${url.replace(/token\/[^/]+/, 'token/***')}`);

          let response;
          
          if (endpoint.method === 'GET') {
            response = await axios.get(url, {
              params: {
                [endpoint.param]: cleanNumber
              }
            });
          } else {
            response = await axios.post(url, {
              phone: cleanNumber
            });
          }

          console.log('📥 [ZAPI] Resposta:', JSON.stringify(response.data, null, 2));

          // Verificar diferentes formatos de resposta
          let exists = false;
          
          if (response.data.exists !== undefined) {
            exists = response.data.exists === true;
          } else if (response.data.isRegistered !== undefined) {
            exists = response.data.isRegistered === true;
          } else if (response.data.registered !== undefined) {
            exists = response.data.registered === true;
          } else if (response.data.valid !== undefined) {
            exists = response.data.valid === true;
          } else if (response.data.status === 'valid' || response.data.status === 'registered') {
            exists = true;
          }

          console.log(`✅ [ZAPI] Endpoint funcionou: ${endpoint.method} ${endpoint.path}`);
          console.log(`${exists ? '✅' : '❌'} [ZAPI] Número ${cleanNumber}: ${exists ? 'EXISTE' : 'NÃO EXISTE'}`);

          return exists;

        } catch (error) {
          console.log(`❌ [ZAPI] Falhou: ${endpoint.method} ${endpoint.path} - ${error.response?.status || error.message}`);
          lastError = error;
          // Continuar tentando próximo endpoint
          continue;
        }
      }

      // Se chegou aqui, nenhum endpoint funcionou
      console.error('❌ [ZAPI] Todos os endpoints falharam!');
      console.error('❌ [ZAPI] Último erro:', lastError.message);
      if (lastError.response) {
        console.error('❌ [ZAPI] Status:', lastError.response.status);
        console.error('❌ [ZAPI] Dados:', JSON.stringify(lastError.response.data, null, 2));
      }
      
      throw new Error('Nenhum endpoint de validação da Z-API funcionou. Verifique suas credenciais.');

    } catch (error) {
      console.error('❌ [ZAPI] Erro fatal ao verificar número:', error.message);
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