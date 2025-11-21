const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const whatsappService = require('./messages');

class NotificationService {
  constructor() {
    this.client = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  }

  /**
   * Mascara dados sensíveis para logs
   */
  maskSensitiveData(data) {
    if (!data) return '***';
    return data.substring(0, 3) + '***' + data.substring(data.length - 3);
  }

  /**
   * Formata dias da semana para exibição
   * @param {array} days - Array de dias (ex: ['segunda', 'terca', 'quarta'])
   * @returns {string} - Dias formatados (ex: "Segunda, Terça e Quarta")
   */
  formatDays(days) {
    if (!days || days.length === 0) return 'Não configurado';
    
    const dayNames = {
      'segunda': 'Segunda',
      'terca': 'Terça',
      'quarta': 'Quarta',
      'quinta': 'Quinta',
      'sexta': 'Sexta',
      'sabado': 'Sábado',
      'domingo': 'Domingo'
    };
    
    if (days.length === 1) {
      return `Toda ${dayNames[days[0]]}`;
    }
    
    if (days.length === 5 && 
        days.includes('segunda') && 
        days.includes('terca') && 
        days.includes('quarta') && 
        days.includes('quinta') && 
        days.includes('sexta')) {
      return 'Dias úteis (Segunda a Sexta)';
    }
    
    if (days.length === 7) {
      return 'Todos os dias';
    }
    
    const formatted = days.map(d => dayNames[d]);
    
    if (formatted.length === 2) {
      return `Toda ${formatted[0]} e ${formatted[1]}`;
    }
    
    const last = formatted.pop();
    return `Toda ${formatted.join(', ')} e ${last}`;
  }

  /**
   * Busca configurações de notificação de um usuário
   * @param {string} userId - ID do usuário
   * @returns {Promise<object>}
   */
  async getNotificationSettings(userId) {
    const { data, error } = await this.client
      .from('notification_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Busca perfil do usuário
   * @param {string} userId - ID do usuário
   * @returns {Promise<object>}
   */
  async getUserProfile(userId) {
    const { data, error } = await this.client
      .from('profiles')
      .select('full_name, whatsapp_number')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Busca estatísticas de domínios críticos de um usuário
   * @param {string} userId - ID do usuário
   * @returns {Promise<object>}
   */
  async getCriticalDomainsStats(userId) {
    try {
      // Buscar domínios suspensos
      const { count: suspended, error: suspendedError } = await this.client
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'suspended');

      if (suspendedError) throw suspendedError;

      // Buscar domínios expirados
      const { count: expired, error: expiredError } = await this.client
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'expired');

      if (expiredError) throw expiredError;

      // Buscar domínios próximos a expirar (15 dias)
      const fifteenDaysFromNow = new Date();
      fifteenDaysFromNow.setDate(fifteenDaysFromNow.getDate() + 15);

      const { count: expiringSoon, error: expiringSoonError } = await this.client
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'active')
        .lte('expiration_date', fifteenDaysFromNow.toISOString())
        .gte('expiration_date', new Date().toISOString());

      if (expiringSoonError) throw expiringSoonError;

      return {
        suspended: suspended || 0,
        expired: expired || 0,
        expiringSoon: expiringSoon || 0
      };
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao buscar estatísticas:', error.message);
      return {
        suspended: 0,
        expired: 0,
        expiringSoon: 0
      };
    }
  }

  /**
   * Verifica se deve enviar notificação com base na última notificação enviada
   * @param {string} userId - ID do usuário
   * @param {number} intervalHours - Intervalo em horas entre notificações
   * @returns {Promise<boolean>}
   */
  async shouldSendNotification(userId, intervalHours) {
    try {
      const { data, error } = await this.client
        .from('notification_settings')
        .select('last_notification_sent')
        .eq('user_id', userId)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;

      if (!data || !data.last_notification_sent) {
        return true;
      }

      const lastSent = new Date(data.last_notification_sent);
      const now = new Date();
      const hoursDiff = (now - lastSent) / (1000 * 60 * 60);

      return hoursDiff >= intervalHours;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao verificar intervalo:', error.message);
      return true;
    }
  }

  /**
   * Atualiza timestamp da última notificação enviada
   * @param {string} userId - ID do usuário
   * @returns {Promise<void>}
   */
  async updateLastNotificationSent(userId) {
    const { error } = await this.client
      .from('notification_settings')
      .update({ last_notification_sent: new Date().toISOString() })
      .eq('user_id', userId);

    if (error) {
      console.error('❌ [NOTIF] Erro ao atualizar timestamp:', error.message);
    }
  }

  /**
   * Registra log de notificação enviada
   * @param {string} userId - ID do usuário
   * @param {string} notificationType - Tipo de notificação
   * @param {object} metadata - Metadados da notificação
   * @returns {Promise<void>}
   */
  async logNotification(userId, notificationType, metadata = {}) {
    try {
      const { error } = await this.client
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: notificationType,
          metadata: metadata,
          sent_at: new Date().toISOString()
        });

      if (error) {
        console.error('❌ [NOTIF] Erro ao registrar log:', error.message);
      }
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao registrar log:', error.message);
    }
  }

  /**
   * Envia alerta imediato de domínio suspenso
   * @param {string} userId - ID do usuário
   * @param {string} domainName - Nome do domínio
   * @returns {Promise<object>}
   */
  async sendSuspendedDomainAlert(userId, domainName) {
    try {
      const settings = await this.getNotificationSettings(userId);
      
      if (!settings || !settings.alert_suspended) {
        return {
          success: false,
          message: 'Notificações de domínios suspensos desativadas'
        };
      }

      const profile = await this.getUserProfile(userId);
      
      if (!profile.whatsapp_number) {
        return {
          success: false,
          message: 'Usuário não possui número de WhatsApp cadastrado'
        };
      }

      const result = await whatsappService.sendSuspendedDomainAlert(
        profile.whatsapp_number,
        domainName,
        profile.full_name || 'Cliente'
      );

      if (result.success) {
        await this.logNotification(userId, 'suspended_domain_alert', {
          domain_name: domainName
        });
      }

      return result;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao enviar alerta de suspenso:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Envia alerta imediato de domínio expirado
   * @param {string} userId - ID do usuário
   * @param {string} domainName - Nome do domínio
   * @returns {Promise<object>}
   */
  async sendExpiredDomainAlert(userId, domainName) {
    try {
      const settings = await this.getNotificationSettings(userId);
      
      if (!settings || !settings.alert_expired) {
        return {
          success: false,
          message: 'Notificações de domínios expirados desativadas'
        };
      }

      const profile = await this.getUserProfile(userId);
      
      if (!profile.whatsapp_number) {
        return {
          success: false,
          message: 'Usuário não possui número de WhatsApp cadastrado'
        };
      }

      const result = await whatsappService.sendExpiredDomainAlert(
        profile.whatsapp_number,
        domainName,
        profile.full_name || 'Cliente'
      );

      if (result.success) {
        await this.logNotification(userId, 'expired_domain_alert', {
          domain_name: domainName
        });
      }

      return result;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao enviar alerta de expirado:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Envia relatório de domínios críticos
   * @param {string} userId - ID do usuário
   * @returns {Promise<object>}
   */
  async sendCriticalDomainsReport(userId) {
    try {
      const settings = await this.getNotificationSettings(userId);
      
      if (!settings) {
        return {
          success: false,
          message: 'Usuário não possui configurações de notificação'
        };
      }

      const profile = await this.getUserProfile(userId);
      
      if (!profile.whatsapp_number) {
        return {
          success: false,
          message: 'Usuário não possui número de WhatsApp cadastrado'
        };
      }

      const intervalHours = settings.notification_interval_hours || 6;
      const shouldSend = await this.shouldSendNotification(userId, intervalHours);

      if (!shouldSend) {
        return {
          success: false,
          message: 'Intervalo mínimo entre notificações não atingido'
        };
      }

      const stats = await this.getCriticalDomainsStats(userId);

      if (stats.suspended === 0 && stats.expired === 0 && stats.expiringSoon === 0) {
        return {
          success: false,
          message: 'Nenhum domínio crítico para reportar'
        };
      }

      const result = await whatsappService.sendCriticalDomainsReport(
        profile.whatsapp_number,
        profile.full_name || 'Cliente',
        stats
      );

      if (result.success) {
        await this.updateLastNotificationSent(userId);
        await this.logNotification(userId, 'critical_domains_report', stats);
      }

      return result;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao enviar relatório:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Envia alerta de teste com domínios críticos
   * @param {string} userId - ID do usuário
   * @returns {Promise<object>}
   */
  async sendTestAlert(userId) {
    try {
      console.log('🧪 [TEST] Iniciando mensagem de verificação');

      // Buscar perfil do usuário
      const { data: profile, error: profileError } = await this.client
        .from('profiles')
        .select('full_name, whatsapp_number')
        .eq('id', userId)
        .single();

      if (profileError) {
        console.error('❌ [TEST] Erro ao buscar perfil:', profileError.message);
        throw profileError;
      }

      const firstName = whatsappService.getFirstName(profile.full_name);
      console.log('✅ [TEST] Perfil encontrado:', firstName);

      if (!profile.whatsapp_number) {
        throw new Error('Usuário não tem número de WhatsApp cadastrado');
      }

      // Buscar configurações de notificação (para recorrência)
      const { data: settings, error: settingsError } = await this.client
        .from('notification_settings')
        .select('notification_days, notification_interval_hours')
        .eq('user_id', userId)
        .maybeSingle();

      if (settingsError && settingsError.code !== 'PGRST116') {
        console.error('❌ [TEST] Erro ao buscar configurações:', settingsError.message);
      }

      // Buscar estatísticas de domínios
      const stats = await this.getCriticalDomainsStats(userId);

      console.log(`📊 [TEST] Domínios: ${stats.suspended} suspensos, ${stats.expired} expirados, ${stats.expiringSoon} expirando`);

      // Se não tem domínios críticos
      if (stats.suspended === 0 && stats.expired === 0 && stats.expiringSoon === 0) {
        const testMessage = `🤖 *DOMAIN HUB*

⚠️ *MENSAGEM DE VERIFICAÇÃO*

${firstName}! Esta é uma mensagem de verificação.

✅ *Configuração concluída com sucesso!*

*Ótima notícia:* Você não tem domínios com problemas no momento! 🎉

📊 Status atual: Todos os domínios OK

━━━━━━━━━━━━━━━━━━━━━

📋 *Configuração da recorrência:*

${settings && settings.notification_days && settings.notification_days.length > 0 
  ? this.formatDays(settings.notification_days) 
  : 'Não configurado'}
A cada ${settings?.notification_interval_hours || 6} hora${(settings?.notification_interval_hours || 6) > 1 ? 's' : ''}

━━━━━━━━━━━━━━━━━━━━━

_Sistema ativo e monitorando 24/7_`;

        console.log('📤 [TEST] Enviando mensagem (sem domínios críticos)');
        const result = await whatsappService.sendMessage(profile.whatsapp_number, testMessage);
        
        if (!result.success) {
          console.error('❌ [TEST] Falha ao enviar:', result.error);
          throw new Error(result.error);
        }

        console.log('✅ [TEST] Mensagem enviada com sucesso');

        return {
          phoneNumber: whatsappService.maskPhone(profile.whatsapp_number),
          alertsSent: 0,
          suspended: 0,
          expired: 0,
          expiringSoon: 0,
          message: 'Verificação enviada - Nenhum domínio crítico'
        };
      }

      // Gerar mensagem formatada com domínios críticos
      let message = `🤖 *DOMAIN HUB*

⚠️ *MENSAGEM DE VERIFICAÇÃO*

${firstName}! Esta é uma mensagem de verificação.

Você tem domínios que precisam de atenção:

`;

      // Adicionar contadores sem listar domínios
      if (stats.suspended > 0) {
        message += `🔴 *${stats.suspended} Domínio${stats.suspended > 1 ? 's' : ''} Suspenso${stats.suspended > 1 ? 's' : ''}*\n`;
      }

      if (stats.expired > 0) {
        message += `🟠 *${stats.expired} Domínio${stats.expired > 1 ? 's' : ''} Expirado${stats.expired > 1 ? 's' : ''}*\n`;
      }

      if (stats.expiringSoon > 0) {
        message += `🟡 *${stats.expiringSoon} Domínio${stats.expiringSoon > 1 ? 's' : ''} Expira${stats.expiringSoon > 1 ? 'ndo' : ''} em 15 dias*\n`;
      }

      message += `
━━━━━━━━━━━━━━━━━━━━━

⚠️ *Possíveis Consequências:*

• Sites offline
• Perda de escala
• Bloqueio de acesso ao painel ADMIN

━━━━━━━━━━━━━━━━━━━━━

👉 *Ação Necessária:*
Acesse o painel Domain Hub para resolver!

━━━━━━━━━━━━━━━━━━━━━

📆 *Configuração da recorrência:*

${settings && settings.notification_days && settings.notification_days.length > 0 
  ? this.formatDays(settings.notification_days) 
  : 'Não configurado'}
A cada ${settings?.notification_interval_hours || 6} hora${(settings?.notification_interval_hours || 6) > 1 ? 's' : ''}

━━━━━━━━━━━━━━━━━━━━━

✅_Sistema ativo e monitorando 24/7_`;

      console.log('📤 [TEST] Enviando mensagem com alertas');
      const result = await whatsappService.sendMessage(profile.whatsapp_number, message);
      
      if (!result.success) {
        console.error('❌ [TEST] Falha ao enviar:', result.error);
        throw new Error(result.error || 'Erro desconhecido ao enviar mensagem');
      }

      console.log(`✅ [TEST] Alerta enviado: ${stats.suspended + stats.expired + stats.expiringSoon} domínios`);

      return {
        phoneNumber: whatsappService.maskPhone(profile.whatsapp_number),
        alertsSent: stats.suspended + stats.expired + stats.expiringSoon,
        suspended: stats.suspended,
        expired: stats.expired,
        expiringSoon: stats.expiringSoon
      };

    } catch (error) {
      console.error('❌ [TEST] Erro:', error.message);
      throw error;
    }
  }
}

module.exports = new NotificationService();