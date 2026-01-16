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

  // ============================================================
  // GESTÃO DE CONTATOS (NOVO)
  // ============================================================

  /**
   * Lista todos os contatos configurados para notificações
   * @returns {Promise<array>}
   */
  async listContacts() {
    try {
      const { data, error } = await this.client
        .from('notification_settings')
        .select(`
          id, user_id, is_active, display_name,
          notification_days, notification_interval_hours,
          alert_expired, alert_suspended, alert_expiring_soon, created_at,
          profiles:user_id ( full_name, whatsapp_number )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return data.map(item => ({
        id: item.id,
        user_id: item.user_id,
        full_name: item.profiles?.full_name || null,
        whatsapp_number: item.profiles?.whatsapp_number || null,
        is_active: item.is_active ?? true,
        display_name: item.display_name,
        notification_days: item.notification_days || [],
        notification_interval_hours: item.notification_interval_hours || 6,
        alert_expired: item.alert_expired ?? true,
        alert_suspended: item.alert_suspended ?? true,
        alert_expiring_soon: item.alert_expiring_soon ?? true,
        created_at: item.created_at
      }));
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao listar contatos:', error.message);
      throw error;
    }
  }

  /**
   * Adiciona um novo contato para receber notificações
   * @param {string} phoneNumber - Número de telefone
   * @param {string} displayName - Nome de exibição (opcional)
   * @param {object} settings - Configurações de notificação
   * @returns {Promise<object>}
   */
  async addContact(phoneNumber, displayName = null, settings = {}) {
    try {
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      console.log('📱 [NOTIF] Adicionando contato:', whatsappService.maskPhone(cleanNumber));

      // Verificar se número existe no WhatsApp
      const exists = await whatsappService.checkPhoneNumber(cleanNumber);
      if (!exists) {
        throw new Error('Número não está registrado no WhatsApp');
      }

      // Verificar se já existe um perfil com esse número
      let { data: existingProfile } = await this.client
        .from('profiles')
        .select('id, full_name')
        .eq('whatsapp_number', cleanNumber)
        .maybeSingle();

      let userId, fullName;

      if (existingProfile) {
        userId = existingProfile.id;
        fullName = existingProfile.full_name;
        console.log('✅ [NOTIF] Perfil existente encontrado');
      } else {
        // Criar novo perfil
        const { data: newProfile, error: createError } = await this.client
          .from('profiles')
          .insert({
            whatsapp_number: cleanNumber,
            full_name: displayName || `Contato ${cleanNumber.slice(-4)}`,
            is_admin: false,
            is_owner: false
          })
          .select('id, full_name')
          .single();

        if (createError) throw createError;
        userId = newProfile.id;
        fullName = newProfile.full_name;
        console.log('✅ [NOTIF] Novo perfil criado');
      }

      // Verificar se já existe notification_settings
      const { data: existingSettings } = await this.client
        .from('notification_settings')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      if (existingSettings) {
        throw new Error('Contato já está cadastrado para receber notificações');
      }

      // Criar notification_settings
      const { data: newSettings, error: settingsError } = await this.client
        .from('notification_settings')
        .insert({
          user_id: userId,
          is_active: true,
          display_name: displayName,
          notification_days: settings.notification_days || ['segunda', 'terca', 'quarta', 'quinta', 'sexta'],
          notification_interval_hours: settings.notification_interval_hours || 6,
          alert_expired: settings.alert_expired ?? true,
          alert_suspended: settings.alert_suspended ?? true,
          alert_expiring_soon: settings.alert_expiring_soon ?? true
        })
        .select()
        .single();

      if (settingsError) throw settingsError;

      console.log('✅ [NOTIF] Contato adicionado com sucesso');

      return {
        success: true,
        contact: {
          id: newSettings.id,
          user_id: userId,
          full_name: fullName,
          whatsapp_number: cleanNumber,
          display_name: displayName,
          ...newSettings
        }
      };
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao adicionar contato:', error.message);
      throw error;
    }
  }

  /**
   * Atualiza configurações de um contato
   * @param {string} settingsId - ID do notification_settings
   * @param {object} updates - Campos a atualizar
   * @returns {Promise<object>}
   */
  async updateContact(settingsId, updates) {
    try {
      const allowedFields = [
        'is_active', 'display_name', 'notification_days',
        'notification_interval_hours', 'alert_expired',
        'alert_suspended', 'alert_expiring_soon'
      ];

      const filteredUpdates = {};
      for (const key of allowedFields) {
        if (updates[key] !== undefined) filteredUpdates[key] = updates[key];
      }

      const { data, error } = await this.client
        .from('notification_settings')
        .update(filteredUpdates)
        .eq('id', settingsId)
        .select()
        .single();

      if (error) throw error;

      console.log('✅ [NOTIF] Contato atualizado:', settingsId);
      return { success: true, contact: data };
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao atualizar contato:', error.message);
      throw error;
    }
  }

  /**
   * Remove um contato
   * @param {string} settingsId - ID do notification_settings
   * @returns {Promise<object>}
   */
  async removeContact(settingsId) {
    try {
      const { error } = await this.client
        .from('notification_settings')
        .delete()
        .eq('id', settingsId);

      if (error) throw error;

      console.log('✅ [NOTIF] Contato removido:', settingsId);
      return { success: true };
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao remover contato:', error.message);
      throw error;
    }
  }

  // ============================================================
  // FUNÇÕES EXISTENTES (MANTIDAS)
  // ============================================================

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
   * Registra log de notificação enviada (FUNÇÃO ORIGINAL - MANTIDA)
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

  // ============================================================
  // LOGS DE NOTIFICAÇÃO COMPLETO (NOVO)
  // ============================================================

  /**
   * Registra log de notificação com todos os detalhes
   * @param {string} userId - ID do usuário
   * @param {string} notificationType - Tipo (whatsapp, email, etc)
   * @param {string} alertType - Tipo de alerta (domain_expired, domain_suspended, etc)
   * @param {string} status - Status (pending, sending, sent, delivered, read, failed)
   * @param {object} details - Detalhes adicionais
   * @returns {Promise<object>}
   */
  async logNotificationComplete(userId, notificationType, alertType, status, details = {}) {
    try {
      const logData = {
        user_id: userId,
        notification_type: notificationType,
        alert_type: alertType,
        status: status,
        phone_number: details.phoneNumber || null,
        domain_name: details.domainName || null,
        message_content: details.messageContent || null,
        whatsapp_message_id: details.messageId || null,
        metadata: details.metadata || {},
        sent_at: ['sent', 'delivered', 'read'].includes(status) ? new Date().toISOString() : null
      };

      const { data, error } = await this.client
        .from('notification_logs')
        .insert(logData)
        .select()
        .single();

      if (error) {
        console.error('❌ [NOTIF] Erro ao registrar log completo:', error.message);
        return null;
      }

      console.log('📝 [NOTIF] Log registrado:', data.id);
      return data;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao registrar log completo:', error.message);
      return null;
    }
  }

  /**
   * Atualiza status de um log de notificação
   * @param {string} logId - ID do log
   * @param {string} status - Novo status
   * @param {object} additionalData - Dados adicionais
   * @returns {Promise<object>}
   */
  async updateLogStatus(logId, status, additionalData = {}) {
    try {
      const updateData = { status, updated_at: new Date().toISOString() };

      if (status === 'delivered') updateData.delivered_at = new Date().toISOString();
      else if (status === 'read') updateData.read_at = new Date().toISOString();
      else if (status === 'failed') {
        updateData.failed_at = new Date().toISOString();
        updateData.error_message = additionalData.errorMessage || null;
      }

      const { data, error } = await this.client
        .from('notification_logs')
        .update(updateData)
        .eq('id', logId)
        .select()
        .single();

      if (error) throw error;

      console.log('📝 [NOTIF] Status atualizado:', logId, '->', status);
      return data;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao atualizar status:', error.message);
      return null;
    }
  }

  /**
   * Atualiza status por messageId do WhatsApp (para webhook)
   * @param {string} messageId - ID da mensagem do WhatsApp
   * @param {string} status - Novo status
   * @param {object} additionalData - Dados adicionais
   * @returns {Promise<object>}
   */
  async updateLogStatusByMessageId(messageId, status, additionalData = {}) {
    try {
      const updateData = { status, updated_at: new Date().toISOString() };

      if (status === 'delivered') updateData.delivered_at = new Date().toISOString();
      else if (status === 'read') updateData.read_at = new Date().toISOString();
      else if (status === 'failed') {
        updateData.failed_at = new Date().toISOString();
        updateData.error_message = additionalData.errorMessage || null;
      }

      const { data, error } = await this.client
        .from('notification_logs')
        .update(updateData)
        .eq('whatsapp_message_id', messageId)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          console.log('⚠️ [NOTIF] MessageId não encontrado:', messageId);
          return null;
        }
        throw error;
      }

      console.log('📝 [NOTIF] Status atualizado via messageId:', messageId, '->', status);
      return data;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao atualizar status por messageId:', error.message);
      return null;
    }
  }

  /**
   * Busca logs de notificação de um usuário
   * @param {string} userId - ID do usuário
   * @param {number} limit - Limite de registros
   * @returns {Promise<array>}
   */
  async getNotificationLogs(userId, limit = 100) {
    try {
      const { data, error } = await this.client
        .from('notification_logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao buscar logs:', error.message);
      return [];
    }
  }

  // ============================================================
  // ENVIO DE ALERTAS (EXISTENTES - ATUALIZADOS COM LOG COMPLETO)
  // ============================================================

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

      // Log original (mantido para compatibilidade)
      if (result.success) {
        await this.logNotification(userId, 'suspended_domain_alert', {
          domain_name: domainName
        });
      }

      // Log completo (novo)
      await this.logNotificationComplete(userId, 'whatsapp', 'domain_suspended', result.success ? 'sent' : 'failed', {
        phoneNumber: profile.whatsapp_number,
        domainName: domainName,
        messageId: result.messageId,
        metadata: { domainName, userName: profile.full_name }
      });

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

      // Log original (mantido para compatibilidade)
      if (result.success) {
        await this.logNotification(userId, 'expired_domain_alert', {
          domain_name: domainName
        });
      }

      // Log completo (novo)
      await this.logNotificationComplete(userId, 'whatsapp', 'domain_expired', result.success ? 'sent' : 'failed', {
        phoneNumber: profile.whatsapp_number,
        domainName: domainName,
        messageId: result.messageId,
        metadata: { domainName, userName: profile.full_name }
      });

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
        // Log original (mantido para compatibilidade)
        await this.logNotification(userId, 'critical_domains_report', stats);
      }

      // Log completo (novo)
      await this.logNotificationComplete(userId, 'whatsapp', 'critical_report', result.success ? 'sent' : 'failed', {
        phoneNumber: profile.whatsapp_number,
        messageId: result.messageId,
        metadata: { ...stats, userName: profile.full_name }
      });

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
        const testMessage = `🤖 *DOMAIN HUB*\n\n⚠️ *MENSAGEM DE VERIFICAÇÃO*\n\n${firstName}! Esta é uma mensagem de verificação.\n\n✅ *Configuração concluída com sucesso!*\n\n*Ótima notícia:* Você não tem domínios com problemas no momento! 🎉\n\n📊 Status atual: Todos os domínios OK\n\n━━━━━━━━━━━━━━━━━━━━━\n\n📋 *Configuração da recorrência:*\n\n${settings && settings.notification_days && settings.notification_days.length > 0 
  ? this.formatDays(settings.notification_days) 
  : 'Não configurado'}\nA cada ${settings?.notification_interval_hours || 6} hora${(settings?.notification_interval_hours || 6) > 1 ? 's' : ''}\n\n━━━━━━━━━━━━━━━━━━━━━\n\n_Sistema ativo e monitorando 24/7_`;

        console.log('📤 [TEST] Enviando mensagem (sem domínios críticos)');
        const result = await whatsappService.sendMessage(profile.whatsapp_number, testMessage);
        
        if (!result.success) {
          console.error('❌ [TEST] Falha ao enviar:', result.error);
          throw new Error(result.error);
        }

        console.log('✅ [TEST] Mensagem enviada com sucesso');

        // Log completo (novo)
        await this.logNotificationComplete(userId, 'whatsapp', 'test_message', 'sent', {
          phoneNumber: profile.whatsapp_number,
          messageContent: testMessage,
          messageId: result.messageId,
          metadata: { ...stats, userName: profile.full_name, isTest: true }
        });

        return {
          phoneNumber: whatsappService.maskPhone(profile.whatsapp_number),
          alertsSent: 0,
          suspended: 0,
          expired: 0,
          expiringSoon: 0,
          message: 'Verificação enviada - Nenhum domínio crítico',
          messageId: result.messageId
        };
      }

      // Gerar mensagem formatada com domínios críticos
      let message = `🤖 *DOMAIN HUB*\n\n⚠️ *MENSAGEM DE VERIFICAÇÃO*\n\n${firstName}! Esta é uma mensagem de verificação.\n\nVocê tem domínios que precisam de atenção:\n\n`;

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

      message += `\n━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *Possíveis Consequências:*\n\n• Sites offline\n• Perda de escala\n• Bloqueio de acesso ao painel ADMIN\n\n━━━━━━━━━━━━━━━━━━━━━\n\n👉 *Ação Necessária:*\nAcesse o painel Domain Hub para resolver!\n\n━━━━━━━━━━━━━━━━━━━━━\n\n➡️ *Configuração da recorrência:*\n\n${settings && settings.notification_days && settings.notification_days.length > 0 
  ? this.formatDays(settings.notification_days) 
  : 'Não configurado'}\nA cada ${settings?.notification_interval_hours || 6} hora${(settings?.notification_interval_hours || 6) > 1 ? 's' : ''}\n\n━━━━━━━━━━━━━━━━━━━━━\n\n✅ _Sistema ativo e monitorando 24/7_`;

      console.log('📤 [TEST] Enviando mensagem com alertas');
      const result = await whatsappService.sendMessage(profile.whatsapp_number, message);
      
      if (!result.success) {
        console.error('❌ [TEST] Falha ao enviar:', result.error);
        throw new Error(result.error || 'Erro desconhecido ao enviar mensagem');
      }

      console.log(`✅ [TEST] Alerta enviado: ${stats.suspended + stats.expired + stats.expiringSoon} domínios`);

      // Log completo (novo)
      await this.logNotificationComplete(userId, 'whatsapp', 'test_message', 'sent', {
        phoneNumber: profile.whatsapp_number,
        messageContent: message,
        messageId: result.messageId,
        metadata: { ...stats, userName: profile.full_name, isTest: true }
      });

      return {
        phoneNumber: whatsappService.maskPhone(profile.whatsapp_number),
        alertsSent: stats.suspended + stats.expired + stats.expiringSoon,
        suspended: stats.suspended,
        expired: stats.expired,
        expiringSoon: stats.expiringSoon,
        messageId: result.messageId
      };

    } catch (error) {
      console.error('❌ [TEST] Erro:', error.message);
      throw error;
    }
  }
}

module.exports = new NotificationService();