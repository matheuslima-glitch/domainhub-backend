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
   * Retorna tanto usuários do sistema quanto contatos externos
   * @returns {Promise<array>}
   */
  async listContacts() {
    try {
      // Buscar todos os notification_settings
      const { data: settings, error } = await this.client
        .from('notification_settings')
        .select(`
          id, user_id, is_active, display_name, whatsapp_number,
          notification_days, notification_interval_hours,
          alert_expired, alert_suspended, alert_expiring_soon, created_at
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Para cada registro, buscar o nome/telefone do profiles se tiver user_id
      const contacts = await Promise.all((settings || []).map(async (item) => {
        let fullName = item.display_name;
        let phoneNumber = item.whatsapp_number;

        // Se tem user_id, busca dados do profiles
        if (item.user_id) {
          const { data: profile } = await this.client
            .from('profiles')
            .select('full_name, whatsapp_number')
            .eq('id', item.user_id)
            .maybeSingle();

          if (profile) {
            fullName = fullName || profile.full_name;
            phoneNumber = phoneNumber || profile.whatsapp_number;
          }
        }

        return {
          id: item.id,
          user_id: item.user_id,
          full_name: fullName || null,
          whatsapp_number: phoneNumber || null,
          is_active: item.is_active ?? true,
          display_name: item.display_name,
          notification_days: item.notification_days || [],
          notification_interval_hours: item.notification_interval_hours || 6,
          alert_expired: item.alert_expired ?? true,
          alert_suspended: item.alert_suspended ?? true,
          alert_expiring_soon: item.alert_expiring_soon ?? true,
          created_at: item.created_at,
          is_external: !item.user_id // Flag para identificar contato externo
        };
      }));

      return contacts;
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao listar contatos:', error.message);
      throw error;
    }
  }

  /**
   * Lista usuários do sistema que NÃO possuem número de WhatsApp cadastrado
   * e que ainda NÃO estão no sistema de notificações
   * @returns {Promise<array>}
   */
  async listAvailableUsers() {
    try {
      // Buscar TODOS os notification_settings para ver quem já tem número
      const { data: allSettings, error: settingsError } = await this.client
        .from('notification_settings')
        .select('user_id, whatsapp_number');

      if (settingsError) throw settingsError;

      // Criar lista de user_ids que JÁ TÊM número cadastrado em notification_settings
      const userIdsWithNumber = (allSettings || [])
        .filter(s => s.user_id && s.whatsapp_number && s.whatsapp_number.trim() !== '')
        .map(s => s.user_id);

      console.log(`📋 [NOTIF] ${userIdsWithNumber.length} usuários JÁ possuem número em notification_settings`);

      // Buscar TODOS os profiles
      const { data: profiles, error: profilesError } = await this.client
        .from('profiles')
        .select('id, full_name, whatsapp_number, email')
        .not('full_name', 'is', null)
        .order('full_name', { ascending: true });

      if (profilesError) throw profilesError;

      console.log(`📋 [NOTIF] Total de profiles: ${(profiles || []).length}`);

      // Filtrar apenas os que NÃO têm número cadastrado em notification_settings
      const availableUsers = (profiles || []).filter(profile => {
        const hasNumberInSettings = userIdsWithNumber.includes(profile.id);
        
        console.log(`📋 [NOTIF] ${profile.full_name}: hasNumberInSettings=${hasNumberInSettings}`);
        
        // Retorna apenas quem NÃO tem número em notification_settings
        return !hasNumberInSettings;
      });

      console.log(`📋 [NOTIF] ${availableUsers.length} usuários SEM número disponíveis para cadastro`);

      return availableUsers.map(user => ({
        id: user.id,
        full_name: user.full_name || user.email?.split('@')[0] || 'Sem nome',
        email: user.email
      }));
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao listar usuários disponíveis:', error.message);
      throw error;
    }
  }

  /**
   * Adiciona um novo contato para receber notificações
   * Pode ser usuário do sistema ou contato externo
   * Se o usuário já existe em notification_settings mas sem número, ATUALIZA
   * @param {string} phoneNumber - Número de telefone
   * @param {string} displayName - Nome de exibição (obrigatório para externos)
   * @param {object} settings - Configurações de notificação
   * @param {string|null} userId - ID do usuário (se for usuário interno)
   * @returns {Promise<object>}
   */
  async addContact(phoneNumber, displayName = null, settings = {}, userId = null) {
    try {
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      console.log('📱 [NOTIF] Adicionando/Atualizando contato:', whatsappService.maskPhone(cleanNumber));
      console.log('📱 [NOTIF] UserId fornecido:', userId || 'nenhum (externo)');

      // Verificar se número existe no WhatsApp
      const exists = await whatsappService.checkPhoneNumber(cleanNumber);
      if (!exists) {
        throw new Error('Número não está registrado no WhatsApp');
      }

      // Verificar se já existe outro contato com esse número
      const { data: existingByPhone } = await this.client
        .from('notification_settings')
        .select('id, user_id')
        .eq('whatsapp_number', cleanNumber)
        .maybeSingle();

      if (existingByPhone && existingByPhone.user_id !== userId) {
        throw new Error('Este número já está cadastrado para outro contato');
      }

      let finalUserId = userId;
      let fullName = displayName;
      let isExternal = !userId;

      // Se foi passado um userId, é um usuário interno
      if (userId) {
        // Verificar se o usuário existe
        const { data: profile } = await this.client
          .from('profiles')
          .select('id, full_name')
          .eq('id', userId)
          .single();

        if (!profile) {
          throw new Error('Usuário não encontrado');
        }

        fullName = displayName || profile.full_name;

        // Verificar se já tem notification_settings para esse user_id
        const { data: existingSettings } = await this.client
          .from('notification_settings')
          .select('id')
          .eq('user_id', userId)
          .maybeSingle();

        if (existingSettings) {
          // ATUALIZAR o registro existente com o número
          const { data: updatedSettings, error: updateError } = await this.client
            .from('notification_settings')
            .update({
              whatsapp_number: cleanNumber,
              display_name: fullName,
              notification_days: settings.notification_days || ['segunda', 'terca', 'quarta', 'quinta', 'sexta'],
              notification_interval_hours: settings.notification_interval_hours || 6,
              alert_expired: settings.alert_expired ?? true,
              alert_suspended: settings.alert_suspended ?? true,
              alert_expiring_soon: settings.alert_expiring_soon ?? true
            })
            .eq('id', existingSettings.id)
            .select()
            .single();

          if (updateError) throw updateError;

          // Atualizar também o whatsapp_number no profile do usuário
          await this.client
            .from('profiles')
            .update({ whatsapp_number: cleanNumber })
            .eq('id', userId);

          console.log('✅ [NOTIF] Contato ATUALIZADO com número:', whatsappService.maskPhone(cleanNumber));

          return {
            success: true,
            contact: {
              id: updatedSettings.id,
              user_id: userId,
              full_name: fullName,
              whatsapp_number: cleanNumber,
              display_name: fullName,
              is_external: false,
              ...updatedSettings
            }
          };
        }

        // Atualizar o whatsapp_number no profile do usuário
        await this.client
          .from('profiles')
          .update({ whatsapp_number: cleanNumber })
          .eq('id', userId);

        console.log('✅ [NOTIF] Usuário interno:', fullName);
        isExternal = false;
      } else {
        // Contato externo - verificar se já existe um profile com esse número
        const { data: existingProfile } = await this.client
          .from('profiles')
          .select('id, full_name')
          .eq('whatsapp_number', cleanNumber)
          .maybeSingle();

        if (existingProfile) {
          // Já existe um usuário com esse número - usar ele
          finalUserId = existingProfile.id;
          fullName = displayName || existingProfile.full_name;
          isExternal = false;

          // Verificar se já tem notification_settings
          const { data: existingSettings } = await this.client
            .from('notification_settings')
            .select('id')
            .eq('user_id', finalUserId)
            .maybeSingle();

          if (existingSettings) {
            throw new Error('Este usuário já está cadastrado para receber notificações');
          }

          console.log('✅ [NOTIF] Usuário do sistema encontrado pelo número:', fullName);
        } else {
          // É realmente um contato externo
          if (!displayName || displayName.trim() === '') {
            throw new Error('Nome é obrigatório para contatos externos');
          }
          fullName = displayName;
          isExternal = true;
          console.log('✅ [NOTIF] Adicionando contato externo:', fullName);
        }
      }

      // Criar notification_settings
      const { data: newSettings, error: settingsError } = await this.client
        .from('notification_settings')
        .insert({
          user_id: finalUserId,
          whatsapp_number: cleanNumber,
          display_name: fullName,
          is_active: true,
          notification_days: settings.notification_days || ['segunda', 'terca', 'quarta', 'quinta', 'sexta'],
          notification_interval_hours: settings.notification_interval_hours || 6,
          alert_expired: settings.alert_expired ?? true,
          alert_suspended: settings.alert_suspended ?? true,
          alert_expiring_soon: settings.alert_expiring_soon ?? true
        })
        .select()
        .single();

      if (settingsError) throw settingsError;

      console.log('✅ [NOTIF] Contato adicionado com sucesso - Externo:', isExternal);

      return {
        success: true,
        contact: {
          id: newSettings.id,
          user_id: finalUserId,
          full_name: fullName,
          whatsapp_number: cleanNumber,
          display_name: fullName,
          is_external: isExternal,
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
        'alert_suspended', 'alert_expiring_soon', 'whatsapp_number'
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
   * Busca estatísticas globais de domínios críticos (para contatos externos)
   * @returns {Promise<object>}
   */
  async getGlobalCriticalDomainsStats() {
    try {
      const { count: suspended } = await this.client
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'suspended');

      const { count: expired } = await this.client
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'expired');

      const fifteenDaysFromNow = new Date();
      fifteenDaysFromNow.setDate(fifteenDaysFromNow.getDate() + 15);

      const { count: expiringSoon } = await this.client
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .lte('expiration_date', fifteenDaysFromNow.toISOString())
        .gte('expiration_date', new Date().toISOString());

      return {
        suspended: suspended || 0,
        expired: expired || 0,
        expiringSoon: expiringSoon || 0
      };
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao buscar estatísticas globais:', error.message);
      return { suspended: 0, expired: 0, expiringSoon: 0 };
    }
  }

  /**
   * Busca domínios críticos COM DETALHES (nome, acessos, fonte de tráfego)
   * @param {string} userId - ID do usuário (opcional para busca global)
   * @returns {Promise<object>}
   */
  async getCriticalDomainsWithDetails(userId = null) {
    try {
      const baseQuery = () => {
        let query = this.client
          .from('domains')
          .select('domain_name, status, monthly_visits, traffic_source, expiration_date')
          .order('monthly_visits', { ascending: false });
        
        if (userId) {
          query = query.eq('user_id', userId);
        }
        return query;
      };

      // Buscar domínios suspensos (SEM LIMITE)
      const { data: suspendedDomains, error: suspendedError } = await baseQuery()
        .eq('status', 'suspended');

      if (suspendedError) throw suspendedError;

      // Buscar domínios expirados (SEM LIMITE)
      const { data: expiredDomains, error: expiredError } = await baseQuery()
        .eq('status', 'expired');

      if (expiredError) throw expiredError;

      // Buscar domínios próximos a expirar (15 dias) (SEM LIMITE)
      const fifteenDaysFromNow = new Date();
      fifteenDaysFromNow.setDate(fifteenDaysFromNow.getDate() + 15);

      let expiringSoonQuery = this.client
        .from('domains')
        .select('domain_name, status, monthly_visits, traffic_source, expiration_date')
        .eq('status', 'active')
        .lte('expiration_date', fifteenDaysFromNow.toISOString())
        .gte('expiration_date', new Date().toISOString())
        .order('expiration_date', { ascending: true });

      if (userId) {
        expiringSoonQuery = expiringSoonQuery.eq('user_id', userId);
      }

      const { data: expiringSoonDomains, error: expiringSoonError } = await expiringSoonQuery;

      if (expiringSoonError) throw expiringSoonError;

      return {
        suspended: suspendedDomains || [],
        expired: expiredDomains || [],
        expiringSoon: expiringSoonDomains || [],
        counts: {
          suspended: suspendedDomains?.length || 0,
          expired: expiredDomains?.length || 0,
          expiringSoon: expiringSoonDomains?.length || 0
        }
      };
    } catch (error) {
      console.error('❌ [NOTIF] Erro ao buscar domínios com detalhes:', error.message);
      return {
        suspended: [],
        expired: [],
        expiringSoon: [],
        counts: { suspended: 0, expired: 0, expiringSoon: 0 }
      };
    }
  }

  /**
   * Formata número de acessos para exibição (direto do banco)
   * @param {number} visits - Número de visitas do banco
   * @returns {string}
   */
  formatVisits(visits) {
    if (!visits || visits === 0) return 'Nenhum acesso mensal';
    return visits.toLocaleString('pt-BR') + ' acessos/mês';
  }

  /**
   * Formata fonte de tráfego para exibição (direto do banco, sem tradução)
   * @param {string} source - Fonte de tráfego do banco
   * @returns {string}
   */
  formatTrafficSource(source) {
    if (!source) return 'Não definido';
    return source;
  }

  /**
   * Formata lista de domínios para mensagem WhatsApp (SEM LIMITE)
   * @param {array} domains - Array de domínios
   * @returns {string}
   */
  formatDomainList(domains) {
    if (!domains || domains.length === 0) return '';

    return domains.map(d => {
      const visits = this.formatVisits(d.monthly_visits);
      const source = this.formatTrafficSource(d.traffic_source);
      return `• *${d.domain_name}*\n   📊 ${visits}\n   📢 ${source}`;
    }).join('\n\n');
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
   * @param {string} recipientId - ID do usuário ou null para contatos externos
   * @param {string} notificationType - Tipo (whatsapp, email, etc)
   * @param {string} alertType - Tipo de alerta (domain_expired, domain_suspended, etc)
   * @param {string} status - Status (pending, sending, sent, delivered, read, failed)
   * @param {object} details - Detalhes adicionais (settingsId, phoneNumber, messageId, etc)
   * @returns {Promise<object>}
   */
  async logNotificationComplete(recipientId, notificationType, alertType, status, details = {}) {
    try {
      const logData = {
        user_id: recipientId || null, // Permite NULL para contatos externos
        settings_id: details.settingsId || null, // ID do notification_settings
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

      console.log('📝 [NOTIF] Salvando log:', { 
        user_id: logData.user_id, 
        settings_id: logData.settings_id,
        alert_type: logData.alert_type 
      });

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
      console.log('🔍 [NOTIF] Buscando log com messageId:', messageId);
      
      const updateData = { status, updated_at: new Date().toISOString() };

      if (status === 'sent') updateData.sent_at = new Date().toISOString();
      else if (status === 'delivered') updateData.delivered_at = new Date().toISOString();
      else if (status === 'read') updateData.read_at = new Date().toISOString();
      else if (status === 'failed') {
        updateData.failed_at = new Date().toISOString();
        updateData.error_message = additionalData.errorMessage || null;
      }

      console.log('🔍 [NOTIF] Dados de atualização:', JSON.stringify(updateData));

      // Primeiro, verificar se o registro existe
      const { data: existingLog, error: findError } = await this.client
        .from('notification_logs')
        .select('id, status, whatsapp_message_id')
        .eq('whatsapp_message_id', messageId)
        .maybeSingle();

      if (findError) {
        console.error('❌ [NOTIF] Erro ao buscar log:', findError.message);
        return null;
      }

      if (!existingLog) {
        console.log('⚠️ [NOTIF] MessageId não encontrado na base:', messageId);
        return null;
      }

      console.log('✅ [NOTIF] Log encontrado:', existingLog.id, '- Status atual:', existingLog.status);

      // Atualizar o registro
      const { data, error } = await this.client
        .from('notification_logs')
        .update(updateData)
        .eq('whatsapp_message_id', messageId)
        .select()
        .single();

      if (error) {
        console.error('❌ [NOTIF] Erro ao atualizar:', error.message);
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
   * @param {string} recipientId - ID do usuário ou settingsId
   * @param {number} limit - Limite de registros
   * @returns {Promise<array>}
   */
  async getNotificationLogs(recipientId, limit = 100) {
    try {
      const { data, error } = await this.client
        .from('notification_logs')
        .select('*')
        .eq('user_id', recipientId)
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
  // ENVIO DE ALERTAS (EXISTENTES - MANTIDOS + LOG COMPLETO)
  // ============================================================

  /**
   * Envia alerta imediato de domínio suspenso para TODOS os contatos
   * @param {string} userId - ID do usuário (ignorado, envia para todos)
   * @param {string} domainName - Nome do domínio
   * @returns {Promise<object>}
   */
  async sendSuspendedDomainAlert(userId, domainName) {
    try {
      console.log(`🚨 [SUSPENDED] Enviando alerta para TODOS os contatos: ${domainName}`);

      // Buscar dados do domínio (acessos e fonte de tráfego)
      const { data: domainData } = await this.client
        .from('domains')
        .select('monthly_visits, traffic_source')
        .eq('domain_name', domainName)
        .maybeSingle();

      // Buscar TODOS os contatos com alerta de suspenso ativo
      const { data: contacts, error } = await this.client
        .from('notification_settings')
        .select('id, user_id, display_name, whatsapp_number')
        .eq('is_active', true)
        .eq('alert_suspended', true);

      if (error) {
        console.error('❌ [SUSPENDED] Erro ao buscar contatos:', error.message);
        return { success: false, error: error.message };
      }

      if (!contacts || contacts.length === 0) {
        console.log('ℹ️ [SUSPENDED] Nenhum contato com alerta de suspenso ativo');
        return { success: false, message: 'Nenhum contato configurado' };
      }

      console.log(`📊 [SUSPENDED] ${contacts.length} contato(s) para notificar`);
      let successCount = 0;

      for (const contact of contacts) {
        try {
          let phoneNumber = contact.whatsapp_number;
          let displayName = contact.display_name;

          // Se tem user_id, buscar dados do profile também
          if (contact.user_id) {
            const { data: profile } = await this.client
              .from('profiles')
              .select('full_name, whatsapp_number')
              .eq('id', contact.user_id)
              .maybeSingle();

            if (profile) {
              phoneNumber = phoneNumber || profile.whatsapp_number;
              displayName = displayName || profile.full_name;
            }
          }

          if (!phoneNumber) {
            console.log(`⏭️ [SUSPENDED] ${displayName || contact.id}: Sem WhatsApp`);
            continue;
          }

          phoneNumber = phoneNumber.replace(/\D/g, '');

          const result = await whatsappService.sendSuspendedDomainAlert(
            phoneNumber,
            domainName,
            displayName || 'Cliente',
            domainData?.monthly_visits || 0,
            domainData?.traffic_source || null
          );

          if (result.success) {
            successCount++;
            console.log(`✅ [SUSPENDED] Enviado para ${displayName}`);
            
            // Log original (mantido para compatibilidade)
            await this.logNotification(contact.user_id, 'suspended_domain_alert', {
              domain_name: domainName
            });
          }

          // Log completo
          await this.logNotificationComplete(contact.user_id, 'whatsapp', 'domain_suspended', result.success ? 'sent' : 'failed', {
            settingsId: contact.id,
            phoneNumber: phoneNumber,
            domainName: domainName,
            messageId: result.messageId,
            metadata: { domainName, displayName }
          });

        } catch (contactError) {
          console.error(`❌ [SUSPENDED] Erro para ${contact.id}:`, contactError.message);
        }
      }

      console.log(`📊 [SUSPENDED] Concluído: ${successCount}/${contacts.length} enviados`);
      return { success: successCount > 0, sent: successCount, total: contacts.length };

    } catch (error) {
      console.error('❌ [NOTIF] Erro ao enviar alerta de suspenso:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Envia alerta imediato de domínio expirado para TODOS os contatos
   * @param {string} userId - ID do usuário (ignorado, envia para todos)
   * @param {string} domainName - Nome do domínio
   * @returns {Promise<object>}
   */
  async sendExpiredDomainAlert(userId, domainName) {
    try {
      console.log(`🚨 [EXPIRED] Enviando alerta para TODOS os contatos: ${domainName}`);

      // Buscar dados do domínio (acessos e fonte de tráfego)
      const { data: domainData } = await this.client
        .from('domains')
        .select('monthly_visits, weekly_visits, traffic_source')
        .eq('domain_name', domainName)
        .maybeSingle();

      // Buscar TODOS os contatos com alerta de expirado ativo
      const { data: contacts, error } = await this.client
        .from('notification_settings')
        .select('id, user_id, display_name, whatsapp_number')
        .eq('is_active', true)
        .eq('alert_expired', true);

      if (error) {
        console.error('❌ [EXPIRED] Erro ao buscar contatos:', error.message);
        return { success: false, error: error.message };
      }

      if (!contacts || contacts.length === 0) {
        console.log('ℹ️ [EXPIRED] Nenhum contato com alerta de expirado ativo');
        return { success: false, message: 'Nenhum contato configurado' };
      }

      console.log(`📊 [EXPIRED] ${contacts.length} contato(s) para notificar`);
      let successCount = 0;

      for (const contact of contacts) {
        try {
          let phoneNumber = contact.whatsapp_number;
          let displayName = contact.display_name;

          // Se tem user_id, buscar dados do profile também
          if (contact.user_id) {
            const { data: profile } = await this.client
              .from('profiles')
              .select('full_name, whatsapp_number')
              .eq('id', contact.user_id)
              .maybeSingle();

            if (profile) {
              phoneNumber = phoneNumber || profile.whatsapp_number;
              displayName = displayName || profile.full_name;
            }
          }

          if (!phoneNumber) {
            console.log(`⏭️ [EXPIRED] ${displayName || contact.id}: Sem WhatsApp`);
            continue;
          }

          phoneNumber = phoneNumber.replace(/\D/g, '');

          const result = await whatsappService.sendExpiredDomainAlert(
            phoneNumber,
            domainName,
            displayName || 'Cliente',
            domainData?.monthly_visits || 0,
            domainData?.traffic_source || null,
            domainData?.weekly_visits || 0
          );

          if (result.success) {
            successCount++;
            console.log(`✅ [EXPIRED] Enviado para ${displayName}`);
            
            // Log original (mantido para compatibilidade)
            await this.logNotification(contact.user_id, 'expired_domain_alert', {
              domain_name: domainName
            });
          }

          // Log completo
          await this.logNotificationComplete(contact.user_id, 'whatsapp', 'domain_expired', result.success ? 'sent' : 'failed', {
            settingsId: contact.id,
            phoneNumber: phoneNumber,
            domainName: domainName,
            messageId: result.messageId,
            metadata: { domainName, displayName }
          });

        } catch (contactError) {
          console.error(`❌ [EXPIRED] Erro para ${contact.id}:`, contactError.message);
        }
      }

      console.log(`📊 [EXPIRED] Concluído: ${successCount}/${contacts.length} enviados`);
      return { success: successCount > 0, sent: successCount, total: contacts.length };

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

      // Buscar domínios COM DETALHES
      const domainsData = await this.getCriticalDomainsWithDetails(userId);
      const { counts } = domainsData;
      const totalCritical = counts.suspended + counts.expired + counts.expiringSoon;

      console.log(`📊 [TEST] Domínios: ${counts.suspended} suspensos, ${counts.expired} expirados, ${counts.expiringSoon} expirando`);

      // Se não tem domínios críticos
      if (totalCritical === 0) {
        const testMessage = `🤖 *DOMAIN HUB*\n\n✅ *CADASTRO REALIZADO COM SUCESSO!*\n\n${firstName}, seu número foi cadastrado com sucesso no sistema de monitoramento de alertas para domínios do Domain Hub! 🎉\n\nA partir de agora você receberá alertas em tempo real sobre o status dos seus domínios.\n\n━━━━━━━━━━━━━━━━━━━━━\n\n📋 *Configuração da recorrência:*\n${settings && settings.notification_days && settings.notification_days.length > 0 
  ? this.formatDays(settings.notification_days) 
  : 'Não configurado'}\nA cada ${settings?.notification_interval_hours || 6} hora${(settings?.notification_interval_hours || 6) > 1 ? 's' : ''}\n\n━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *IMPORTANTE:* Salve este número nos seus contatos para garantir o recebimento dos alertas.\n\n_Sistema ativo e monitorando 24/7_`;

        console.log('📤 [TEST] Enviando mensagem (sem domínios críticos)');
        const result = await whatsappService.sendMessage(profile.whatsapp_number, testMessage);
        
        if (!result.success) {
          console.error('❌ [TEST] Falha ao enviar:', result.error);
          throw new Error(result.error);
        }

        console.log('✅ [TEST] Mensagem enviada com sucesso');

        await this.logNotificationComplete(userId, 'whatsapp', 'test_message', 'sent', {
          phoneNumber: profile.whatsapp_number,
          messageContent: testMessage,
          messageId: result.messageId,
          metadata: { ...counts, userName: profile.full_name, isTest: true }
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

      // Gerar mensagem com lista de domínios
      let message = `🤖 *DOMAIN HUB*\n\n⚠️ *ALERTA URGENTE*\n\n${firstName}, você tem ${totalCritical} domínio${totalCritical > 1 ? 's' : ''} que precisa${totalCritical > 1 ? 'm' : ''} de atenção imediata!\n\n━━━━━━━━━━━━━━━━━━━━━`;

      // Domínios Suspensos
      if (counts.suspended > 0) {
        message += `\n\n🔴 *${counts.suspended} Domínio${counts.suspended > 1 ? 's' : ''} Suspenso${counts.suspended > 1 ? 's' : ''}*\n_Requer ação imediata_\n\n`;
        message += this.formatDomainList(domainsData.suspended);
      }

      // Domínios Expirados
      if (counts.expired > 0) {
        message += `\n\n🟠 *${counts.expired} Domínio${counts.expired > 1 ? 's' : ''} Expirado${counts.expired > 1 ? 's' : ''}*\n_Requer renovação urgente_\n\n`;
        message += this.formatDomainList(domainsData.expired);
      }

      // Domínios Expirando
      if (counts.expiringSoon > 0) {
        message += `\n\n🟡 *${counts.expiringSoon} Domínio${counts.expiringSoon > 1 ? 's' : ''} Expirando em Breve*\n_Expiram em até 15 dias_`;
      }

      message += `\n\n━━━━━━━━━━━━━━━━━━━━━\n\n⚡ Verifique AGORA na *Gestão de Domínios* e tome ação imediata!\n\n━━━━━━━━━━━━━━━━━━━━━`;

      console.log('📤 [TEST] Enviando mensagem com alertas');
      const result = await whatsappService.sendMessage(profile.whatsapp_number, message);
      
      if (!result.success) {
        console.error('❌ [TEST] Falha ao enviar:', result.error);
        throw new Error(result.error || 'Erro desconhecido ao enviar mensagem');
      }

      console.log(`✅ [TEST] Alerta enviado: ${counts.suspended + counts.expired + counts.expiringSoon} domínios`);

      await this.logNotificationComplete(userId, 'whatsapp', 'test_message', 'sent', {
        phoneNumber: profile.whatsapp_number,
        messageContent: message,
        messageId: result.messageId,
        metadata: { ...counts, userName: profile.full_name, isTest: true }
      });

      return {
        phoneNumber: whatsappService.maskPhone(profile.whatsapp_number),
        alertsSent: counts.suspended + counts.expired + counts.expiringSoon,
        suspended: counts.suspended,
        expired: counts.expired,
        expiringSoon: counts.expiringSoon,
        messageId: result.messageId
      };

    } catch (error) {
      console.error('❌ [TEST] Erro:', error.message);
      throw error;
    }
  }

  /**
   * Envia alerta de teste para um contato (por settingsId)
   * Funciona tanto para usuários do sistema quanto contatos externos
   * @param {string} settingsId - ID do notification_settings
   * @returns {Promise<object>}
   */
  async sendTestAlertToContact(settingsId) {
    try {
      console.log('🧪 [TEST-CONTACT] Iniciando mensagem de verificação para contato:', settingsId);

      // Buscar o contato
      const { data: settings, error: settingsError } = await this.client
        .from('notification_settings')
        .select('*')
        .eq('id', settingsId)
        .single();

      if (settingsError) throw settingsError;

      let phoneNumber = settings.whatsapp_number;
      let displayName = settings.display_name;

      // Se tem user_id, buscar dados do profile
      if (settings.user_id) {
        const { data: profile } = await this.client
          .from('profiles')
          .select('full_name, whatsapp_number')
          .eq('id', settings.user_id)
          .maybeSingle();

        if (profile) {
          phoneNumber = phoneNumber || profile.whatsapp_number;
          displayName = displayName || profile.full_name;
        }
      }

      if (!phoneNumber) {
        throw new Error('Contato não possui número de WhatsApp cadastrado');
      }

      const firstName = whatsappService.getFirstName(displayName);
      console.log('✅ [TEST-CONTACT] Contato encontrado:', firstName);

      // Buscar domínios COM DETALHES
      const domainsData = settings.user_id 
        ? await this.getCriticalDomainsWithDetails(settings.user_id)
        : await this.getCriticalDomainsWithDetails(null);

      const { counts } = domainsData;
      const totalCritical = counts.suspended + counts.expired + counts.expiringSoon;

      console.log(`📊 [TEST-CONTACT] Domínios: ${counts.suspended} suspensos, ${counts.expired} expirados, ${counts.expiringSoon} expirando`);

           // MENSAGEM 1: Sempre enviar boas-vindas primeiro
      const welcomeMessage = `🤖 *DOMAIN HUB*\n\n✅ *CADASTRO REALIZADO COM SUCESSO!*\n\n${firstName}, seu número foi cadastrado com sucesso no sistema de monitoramento de alertas para domínios do Domain Hub! 🎉\n\nA partir de agora você receberá alertas em tempo real sobre o status dos seus domínios.\n\n━━━━━━━━━━━━━━━━━━━━━\n\n📋 *Configuração da recorrência:*\n${settings.notification_days && settings.notification_days.length > 0 
  ? this.formatDays(settings.notification_days) 
  : 'Não configurado'}\nA cada ${settings.notification_interval_hours || 6} hora${(settings.notification_interval_hours || 6) > 1 ? 's' : ''}\n\n━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *IMPORTANTE:* Salve este número nos seus contatos para garantir o recebimento dos alertas.${totalCritical > 0 ? '\n\n⏳ _Em breve você receberá um relatório com o status atual dos seus domínios..._' : '\n\n_Sistema ativo e monitorando 24/7_'}`;

      console.log('📤 [TEST-CONTACT] Enviando mensagem de boas-vindas');
      const welcomeResult = await whatsappService.sendMessage(phoneNumber, welcomeMessage);

      if (!welcomeResult.success) {
        console.error('❌ [TEST-CONTACT] Falha ao enviar boas-vindas:', welcomeResult.error);
        throw new Error(welcomeResult.error || 'Erro ao enviar mensagem de boas-vindas');
      }

      // Log da mensagem de boas-vindas
      await this.logNotificationComplete(settings.user_id, 'whatsapp', 'welcome_message', 'sent', {
        settingsId: settingsId,
        phoneNumber: phoneNumber,
        messageContent: welcomeMessage,
        messageId: welcomeResult.messageId,
        metadata: { displayName, isTest: true, isWelcome: true }
      });

      // MENSAGEM 2: Se houver domínios críticos, enviar relatório EM SEGUNDO PLANO
      if (totalCritical > 0) {
        // Executar em segundo plano (não bloqueia a resposta)
        setImmediate(async () => {
          try {
            // Aguardar 60 segundos antes de enviar o relatório
            console.log('⏳ [TEST-CONTACT] Aguardando 60 segundos para enviar relatório em segundo plano...');
            await new Promise(resolve => setTimeout(resolve, 60000));

        let reportMessage = `🤖 *DOMAIN HUB*\n\n⚠️ *ALERTA URGENTE*\n\n${firstName}, você tem ${totalCritical} domínio${totalCritical > 1 ? 's' : ''} que precisa${totalCritical > 1 ? 'm' : ''} de atenção imediata!\n\n━━━━━━━━━━━━━━━━━━━━━`;

        // Domínios Suspensos
        if (counts.suspended > 0) {
          reportMessage += `\n\n🔴 *${counts.suspended} Domínio${counts.suspended > 1 ? 's' : ''} Suspenso${counts.suspended > 1 ? 's' : ''}*\n_Requer ação imediata_\n\n`;
          reportMessage += this.formatDomainList(domainsData.suspended);
        }

        // Domínios Expirados
        if (counts.expired > 0) {
          reportMessage += `\n\n🟠 *${counts.expired} Domínio${counts.expired > 1 ? 's' : ''} Expirado${counts.expired > 1 ? 's' : ''}*\n_Requer renovação urgente_\n\n`;
          reportMessage += this.formatDomainList(domainsData.expired);
        }

        // Domínios Expirando
        if (counts.expiringSoon > 0) {
          reportMessage += `\n\n🟡 *${counts.expiringSoon} Domínio${counts.expiringSoon > 1 ? 's' : ''} Expirando em Breve*\n_Expiram em até 15 dias_`;
        }

        reportMessage += `\n\n━━━━━━━━━━━━━━━━━━━━━\n\n⚡ Verifique AGORA na *Gestão de Domínios* e tome ação imediata!\n\n━━━━━━━━━━━━━━━━━━━━━`;

        console.log('📤 [TEST-CONTACT] Enviando relatório de domínios críticos');
            const reportResult = await whatsappService.sendMessage(phoneNumber, reportMessage);

        if (!reportResult.success) {
              console.error('❌ [TEST-CONTACT] Falha ao enviar relatório:', reportResult.error);
            } else {
              // Log do relatório
              await this.logNotificationComplete(settings.user_id, 'whatsapp', 'test_message', 'sent', {
                settingsId: settingsId,
                phoneNumber: phoneNumber,
                messageContent: reportMessage,
                messageId: reportResult.messageId,
                metadata: { ...counts, displayName, isTest: true, isReport: true }
              });
              console.log('✅ [TEST-CONTACT] Relatório enviado com sucesso em segundo plano');
            }
          } catch (error) {
            console.error('❌ [TEST-CONTACT] Erro ao enviar relatório em segundo plano:', error.message);
          }
        });
      }

      // Atualizar last_notification_sent
      await this.client
        .from('notification_settings')
        .update({ last_notification_sent: new Date().toISOString() })
        .eq('id', settingsId);

      console.log('✅ [TEST-CONTACT] Processo finalizado com sucesso');

      return {
        success: true,
        phoneNumber: whatsappService.maskPhone(phoneNumber),
        alertsSent: counts.suspended + counts.expired + counts.expiringSoon,
        suspended: counts.suspended,
        expired: counts.expired,
        expiringSoon: counts.expiringSoon,
        messageId: welcomeResult.messageId
      };

    } catch (error) {
      console.error('❌ [TEST-CONTACT] Erro:', error.message);
      throw error;
    }
  }

  /**
   * Envia relatório GLOBAL de domínios críticos para um contato
   * @param {string} settingsId - ID do notification_settings
   * @returns {Promise<object>}
   */
  async sendGlobalCriticalReport(settingsId) {
    try {
      console.log(`📤 [REPORT] Enviando relatório global para settings: ${settingsId}`);

      // Buscar dados do contato
      const { data: settings, error: settingsError } = await this.client
        .from('notification_settings')
        .select('*')
        .eq('id', settingsId)
        .single();

      if (settingsError) {
        console.error('❌ [REPORT] Erro ao buscar settings:', settingsError.message);
        return { success: false, message: 'Configurações não encontradas' };
      }

      if (!settings.is_active) {
        return { success: false, message: 'Notificações desativadas' };
      }

      // Determinar número de WhatsApp e nome
      let phoneNumber = settings.whatsapp_number;
      let displayName = settings.display_name;

      if (settings.user_id) {
        const { data: profile } = await this.client
          .from('profiles')
          .select('full_name, whatsapp_number')
          .eq('id', settings.user_id)
          .maybeSingle();

        if (profile) {
          phoneNumber = phoneNumber || profile.whatsapp_number;
          displayName = displayName || profile.full_name;
        }
      }

      if (!phoneNumber) {
        return { success: false, message: 'Sem número de WhatsApp' };
      }

      phoneNumber = phoneNumber.replace(/\D/g, '');

      // Buscar estatísticas GLOBAIS
      const stats = await this.getGlobalCriticalDomainsStats();
      const totalCritical = stats.suspended + stats.expired + stats.expiringSoon;

      if (totalCritical === 0) {
        return { success: false, message: 'Nenhum domínio crítico' };
      }

      // Buscar detalhes dos domínios (GLOBAL - sem filtro de user_id)
      const domainsData = await this.getCriticalDomainsWithDetails(null);

      // Montar mensagem
      const firstName = whatsappService.getFirstName(displayName || 'Cliente');
      
      let message = `🤖 *DOMAIN HUB*\n\n⚠️ *RELATÓRIO DE DOMÍNIOS CRÍTICOS*\n\n${firstName}, segue o status atual dos domínios:\n\n━━━━━━━━━━━━━━━━━━━━━`;

      if (stats.suspended > 0 && settings.alert_suspended) {
        message += `\n\n🔴 *${stats.suspended} Domínio${stats.suspended > 1 ? 's' : ''} Suspenso${stats.suspended > 1 ? 's' : ''}*\n_Requer ação imediata_\n\n`;
        message += this.formatDomainList(domainsData.suspended);
      }

      if (stats.expired > 0 && settings.alert_expired) {
        message += `\n\n🟠 *${stats.expired} Domínio${stats.expired > 1 ? 's' : ''} Expirado${stats.expired > 1 ? 's' : ''}*\n_Requer renovação urgente_\n\n`;
        message += this.formatDomainList(domainsData.expired);
      }

      if (stats.expiringSoon > 0 && settings.alert_expiring_soon) {
        message += `\n\n🟡 *${stats.expiringSoon} Domínio${stats.expiringSoon > 1 ? 's' : ''} Expirando em Breve*\n_Expiram em até 15 dias_\n\n`;
        message += this.formatDomainList(domainsData.expiringSoon);
      }

      message += `\n\n━━━━━━━━━━━━━━━━━━━━━\n\n⚡ Verifique AGORA na *Gestão de Domínios*!\n\n━━━━━━━━━━━━━━━━━━━━━`;

      // Enviar mensagem
      const result = await whatsappService.sendMessage(phoneNumber, message);

      if (!result.success) {
        console.error(`❌ [REPORT] Falha ao enviar para ${displayName}:`, result.error);
        return { success: false, message: result.error };
      }

      // Atualizar last_notification_sent
      await this.client
        .from('notification_settings')
        .update({ last_notification_sent: new Date().toISOString() })
        .eq('id', settingsId);

      // Log completo
      await this.logNotificationComplete(settings.user_id, 'whatsapp', 'critical_report', 'sent', {
        settingsId: settingsId,
        phoneNumber: phoneNumber,
        messageContent: message,
        messageId: result.messageId,
        metadata: { ...stats, displayName }
      });

      console.log(`✅ [REPORT] Enviado para ${displayName}`);
      return { success: true, messageId: result.messageId };

    } catch (error) {
      console.error('❌ [REPORT] Erro:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new NotificationService();
