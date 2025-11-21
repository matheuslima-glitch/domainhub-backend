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
      console.log('🧪 [TEST] Iniciando alerta de teste');

      const { data: profile, error: profileError } = await this.client
        .from('profiles')
        .select('full_name, whatsapp_number')
        .eq('id', userId)
        .single();

      if (profileError) {
        console.error('❌ [TEST] Erro ao buscar perfil:', profileError.message);
        throw profileError;
      }

      // Extrair primeiro nome para logs
      const firstName = whatsappService.getFirstName(profile.full_name);
      console.log('✅ [TEST] Perfil encontrado:', firstName);

      if (!profile.whatsapp_number) {
        throw new Error('Usuário não tem número de WhatsApp cadastrado');
      }

      // Buscar domínios críticos
      const { data: domains, error: domainsError } = await this.client
        .from('domains')
        .select('*')
        .eq('user_id', userId)
        .in('status', ['suspended', 'expired'])
        .order('expiration_date', { ascending: true });

      if (domainsError) {
        console.error('❌ [TEST] Erro ao buscar domínios:', domainsError.message);
        throw domainsError;
      }

      console.log(`📊 [TEST] Domínios críticos: ${domains?.length || 0}`);

      // Se não tem domínios críticos
      if (!domains || domains.length === 0) {
        const testMessage = `🤖 *DOMAIN HUB - Teste de Notificação*

Olá ${firstName}! 👋

✅ *Número WhatsApp configurado com sucesso!*

Você receberá alertas automáticos quando:
• 🔴 Domínios forem suspensos
• 🟠 Domínios expirarem
• 🟡 Domínios estiverem próximos do vencimento

*Ótima notícia:* Você não tem domínios com problemas no momento! 🎉

📊 Status atual: Todos os domínios OK

_Sistema ativo e monitorando 24/7_
🕒 ${new Date().toLocaleString('pt-BR')}`;

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
          message: 'Teste enviado - Nenhum domínio crítico'
        };
      }

      // Separar por status
      const suspended = domains.filter(d => d.status === 'suspended');
      const expired = domains.filter(d => d.status === 'expired');

      console.log(`📊 [TEST] Suspensos: ${suspended.length}, Expirados: ${expired.length}`);

      // Gerar mensagem formatada
      let message = `🤖 *DOMAIN HUB*\n\n⚠️ *ALERTA DE TESTE*\n\n${firstName}! Esta é uma mensagem de teste.\n\nVocê tem domínios que precisam de atenção:\n\n`;

      if (suspended.length > 0) {
        message += `🔴 *${suspended.length} Domínio${suspended.length > 1 ? 's' : ''} Suspenso${suspended.length > 1 ? 's' : ''}:*\n`;
        suspended.slice(0, 5).forEach(d => {
          message += `• ${d.domain_name}\n`;
        });
        if (suspended.length > 5) {
          message += `  ... e mais ${suspended.length - 5}\n`;
        }
        message += `\n`;
      }

      if (expired.length > 0) {
        message += `🟠 *${expired.length} Domínio${expired.length > 1 ? 's' : ''} Expirado${expired.length > 1 ? 's' : ''}:*\n`;
        expired.slice(0, 5).forEach(d => {
          message += `• ${d.domain_name}\n`;
        });
        if (expired.length > 5) {
          message += `  ... e mais ${expired.length - 5}\n`;
        }
        message += `\n`;
      }

      message += `⚠️ *Possíveis Consequências:*\n`;
      message += `• Sites offline\n`;
      message += `• E-mails bloqueados\n`;
      message += `• Perda de acesso ao painel\n\n`;
      message += `👉 *Ação Necessária:*\n`;
      message += `Acesse o painel Domain Hub para resolver!\n\n`;
      message += `_Notificação de teste enviada com sucesso ✅_\n`;
      message += `🕒 ${new Date().toLocaleString('pt-BR')}`;

      console.log('📤 [TEST] Enviando mensagem com alertas');
      const result = await whatsappService.sendMessage(profile.whatsapp_number, message);
      
      if (!result.success) {
        console.error('❌ [TEST] Falha ao enviar:', result.error);
        throw new Error(result.error || 'Erro desconhecido ao enviar mensagem');
      }

      console.log(`✅ [TEST] Alerta enviado: ${domains.length} domínios`);

      return {
        phoneNumber: whatsappService.maskPhone(profile.whatsapp_number),
        alertsSent: domains.length,
        suspended: suspended.length,
        expired: expired.length
      };

    } catch (error) {
      console.error('❌ [TEST] Erro:', error.message);
      throw error;
    }
  }
}

module.exports = new NotificationService();