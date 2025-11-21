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
      const { data: suspended, error: suspendedError } = await this.client
        .from('domains')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'suspended');

      if (suspendedError) throw suspendedError;

      // Buscar domínios expirados
      const { data: expired, error: expiredError } = await this.client
        .from('domains')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'expired');

      if (expiredError) throw expiredError;

      // Buscar domínios próximos a expirar (15 dias)
      const fifteenDaysFromNow = new Date();
      fifteenDaysFromNow.setDate(fifteenDaysFromNow.getDate() + 15);

      const { data: expiringSoon, error: expiringSoonError } = await this.client
        .from('domains')
        .select('id', { count: 'exact', head: true })
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
      console.error('Erro ao buscar estatísticas de domínios críticos:', error.message);
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
      console.error('Erro ao verificar última notificação:', error.message);
      return true; // Em caso de erro, permite envio
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
      console.error('Erro ao atualizar última notificação:', error.message);
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
        console.error('Erro ao registrar log de notificação:', error.message);
      }
    } catch (error) {
      console.error('Erro ao registrar log:', error.message);
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
      // Buscar configurações de notificação
      const settings = await this.getNotificationSettings(userId);
      
      // Verificar se notificações de suspensos estão ativas
      if (!settings || !settings.alert_suspended) {
        return {
          success: false,
          message: 'Notificações de domínios suspensos desativadas'
        };
      }

      // Buscar perfil do usuário
      const profile = await getUserProfile(userId);
      
      if (!profile.whatsapp_number) {
        return {
          success: false,
          message: 'Usuário não possui número de WhatsApp cadastrado'
        };
      }

      // Enviar alerta
      const result = await whatsappService.sendSuspendedDomainAlert(
        profile.whatsapp_number,
        domainName,
        profile.full_name || 'Cliente'
      );

      // Registrar log
      if (result.success) {
        await this.logNotification(userId, 'suspended_domain_alert', {
          domain_name: domainName
        });
      }

      return result;
    } catch (error) {
      console.error('Erro ao enviar alerta de domínio suspenso:', error.message);
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
      // Buscar configurações de notificação
      const settings = await this.getNotificationSettings(userId);
      
      // Verificar se notificações de expirados estão ativas
      if (!settings || !settings.alert_expired) {
        return {
          success: false,
          message: 'Notificações de domínios expirados desativadas'
        };
      }

      // Buscar perfil do usuário
      const profile = await this.getUserProfile(userId);
      
      if (!profile.whatsapp_number) {
        return {
          success: false,
          message: 'Usuário não possui número de WhatsApp cadastrado'
        };
      }

      // Enviar alerta
      const result = await whatsappService.sendExpiredDomainAlert(
        profile.whatsapp_number,
        domainName,
        profile.full_name || 'Cliente'
      );

      // Registrar log
      if (result.success) {
        await this.logNotification(userId, 'expired_domain_alert', {
          domain_name: domainName
        });
      }

      return result;
    } catch (error) {
      console.error('Erro ao enviar alerta de domínio expirado:', error.message);
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
      // Buscar configurações de notificação
      const settings = await this.getNotificationSettings(userId);
      
      if (!settings) {
        return {
          success: false,
          message: 'Usuário não possui configurações de notificação'
        };
      }

      // Buscar perfil do usuário
      const profile = await this.getUserProfile(userId);
      
      if (!profile.whatsapp_number) {
        return {
          success: false,
          message: 'Usuário não possui número de WhatsApp cadastrado'
        };
      }

      // Verificar intervalo de notificações
      const intervalHours = settings.notification_interval_hours || 6;
      const shouldSend = await this.shouldSendNotification(userId, intervalHours);

      if (!shouldSend) {
        return {
          success: false,
          message: 'Intervalo mínimo entre notificações não atingido'
        };
      }

      // Buscar estatísticas
      const stats = await this.getCriticalDomainsStats(userId);

      // Verificar se há domínios críticos para reportar
      if (stats.suspended === 0 && stats.expired === 0 && stats.expiringSoon === 0) {
        return {
          success: false,
          message: 'Nenhum domínio crítico para reportar'
        };
      }

      // Enviar relatório
      const result = await whatsappService.sendCriticalDomainsReport(
        profile.whatsapp_number,
        profile.full_name || 'Cliente',
        stats
      );

      // Atualizar timestamp da última notificação
      if (result.success) {
        await this.updateLastNotificationSent(userId);
        await this.logNotification(userId, 'critical_domains_report', stats);
      }

      return result;
    } catch (error) {
      console.error('Erro ao enviar relatório de domínios críticos:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new NotificationService();