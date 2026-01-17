const express = require('express');
const router = express.Router();
const whatsappService = require('../../services/whatsapp/messages');
const notificationService = require('../../services/whatsapp/notifications');

// ============================================================
// VERIFICAÇÃO DE NÚMERO
// ============================================================

/**
 * POST /api/whatsapp/check-number
 * Verifica se um número está registrado no WhatsApp
 */
router.post('/check-number', async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;

    console.log('📱 [WHATSAPP] Validando número:', phoneNumber);

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Número de telefone é obrigatório' });
    }

    const exists = await whatsappService.checkPhoneNumber(phoneNumber);

    console.log(`${exists ? '✅' : '❌'} [WHATSAPP] Número ${phoneNumber}: ${exists ? 'EXISTE' : 'NÃO EXISTE'}`);

    res.json({
      success: true,
      phoneNumber,
      exists,
      message: exists ? 'Número registrado no WhatsApp' : 'Número não encontrado no WhatsApp'
    });
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro na validação:', error.message);
    next(error);
  }
});

// ============================================================
// GESTÃO DE CONTATOS
// ============================================================

/**
 * GET /api/whatsapp/contacts
 * Lista todos os contatos configurados para notificações
 */
router.get('/contacts', async (req, res, next) => {
  try {
    console.log('📋 [WHATSAPP] Listando contatos');

    const contacts = await notificationService.listContacts();

    res.json({
      success: true,
      contacts,
      total: contacts.length
    });
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao listar contatos:', error.message);
    next(error);
  }
});

/**
 * POST /api/whatsapp/contacts
 * Adiciona um novo contato para receber notificações
 */
router.post('/contacts', async (req, res, next) => {
  try {
    const { phoneNumber, displayName, settings } = req.body;

    console.log('➕ [WHATSAPP] Adicionando contato:', phoneNumber);

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Número de telefone é obrigatório' });
    }

    const result = await notificationService.addContact(phoneNumber, displayName, settings || {});

    res.json(result);
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao adicionar contato:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/whatsapp/contacts/:id
 * Atualiza configurações de um contato
 */
router.put('/contacts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    console.log('✏️ [WHATSAPP] Atualizando contato:', id);

    const result = await notificationService.updateContact(id, updates);

    res.json(result);
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao atualizar contato:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/whatsapp/contacts/:id
 * Remove um contato
 */
router.delete('/contacts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    console.log('🗑️ [WHATSAPP] Removendo contato:', id);

    const result = await notificationService.removeContact(id);

    res.json(result);
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao remover contato:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/whatsapp/contacts/:id/toggle
 * Ativa/desativa um contato
 */
router.patch('/contacts/:id/toggle', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    console.log(`🔄 [WHATSAPP] ${is_active ? 'Ativando' : 'Desativando'} contato:`, id);

    const result = await notificationService.updateContact(id, { is_active });

    res.json(result);
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao toggle contato:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/whatsapp/contacts/:id/test
 * Envia mensagem de teste para um contato específico (por settingsId)
 */
router.post('/contacts/:id/test', async (req, res, next) => {
  try {
    const { id } = req.params;

    console.log('🧪 [WHATSAPP] Enviando teste para contato:', id);

    const result = await notificationService.sendTestAlertToContact(id);

    res.json({
      success: true,
      message: 'Mensagem de teste enviada com sucesso!',
      ...result
    });
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao enviar teste:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// LOGS DE NOTIFICAÇÃO
// ============================================================

/**
 * GET /api/whatsapp/logs/:userId
 * Busca logs de notificação de um usuário
 */
router.get('/logs/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { limit = 100 } = req.query;

    console.log('📜 [WHATSAPP] Buscando logs para:', userId);

    const logs = await notificationService.getNotificationLogs(userId, parseInt(limit));

    res.json({
      success: true,
      logs,
      total: logs.length
    });
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao buscar logs:', error.message);
    next(error);
  }
});

// ============================================================
// WEBHOOK ZAPI (Receber status de mensagens)
// ============================================================

/**
 * POST /api/whatsapp/webhook
 * Recebe atualizações de status de mensagens da ZAPI
 */
router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;

    console.log('🔔 [WEBHOOK] Recebido:', JSON.stringify(payload).substring(0, 200));

    const eventType = payload.event || payload.type;
    
    if (eventType === 'message-status-update' || eventType === 'MessageStatusCallback') {
      const messageId = payload.messageId || payload.id?.id || payload.ids?.[0];
      const status = payload.status || payload.ack;

      if (!messageId) {
        console.log('⚠️ [WEBHOOK] MessageId não encontrado no payload');
        return res.status(200).json({ success: true, message: 'No messageId' });
      }

      let mappedStatus;
      switch (status) {
        case 'SENT':
        case 'sent':
        case 1:
          mappedStatus = 'sent';
          break;
        case 'RECEIVED':
        case 'DELIVERED':
        case 'delivered':
        case 2:
          mappedStatus = 'delivered';
          break;
        case 'READ':
        case 'VIEWED':
        case 'read':
        case 3:
        case 4:
          mappedStatus = 'read';
          break;
        case 'PLAYED':
        case 5:
          mappedStatus = 'read';
          break;
        case 'FAILED':
        case 'failed':
        case 'ERROR':
        case 'error':
        case -1:
          mappedStatus = 'failed';
          break;
        default:
          console.log('⚠️ [WEBHOOK] Status desconhecido:', status);
          mappedStatus = null;
      }

      if (mappedStatus) {
        console.log(`📝 [WEBHOOK] Atualizando status: ${messageId} -> ${mappedStatus}`);
        
        const errorMessage = payload.error || payload.errorMessage || null;
        
        await notificationService.updateLogStatusByMessageId(messageId, mappedStatus, {
          errorMessage
        });
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ [WEBHOOK] Erro:', error.message);
    res.status(200).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/whatsapp/webhook
 * Verificação de saúde do webhook
 */
router.get('/webhook', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook WhatsApp DomainHub ativo',
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// ENVIO DE MENSAGENS (EXISTENTES - MANTIDOS)
// ============================================================

/**
 * POST /api/whatsapp/send-test
 * Envia mensagem de teste simples
 */
router.post('/send-test', async (req, res, next) => {
  try {
    const { phoneNumber, userName } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Número de telefone é obrigatório' });
    }

    const message = `🤖 Domain Hub

Olá ${userName || 'Cliente'}!

Esta é uma mensagem de teste para confirmar que suas notificações via WhatsApp estão funcionando corretamente.

✅ Configuração concluída com sucesso!

Você receberá alertas importantes sobre seus domínios neste número.`;

    const result = await whatsappService.sendMessage(phoneNumber, message);

    if (result.success) {
      res.json({ success: true, message: 'Mensagem de teste enviada com sucesso', messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: 'Erro ao enviar mensagem de teste' });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/whatsapp/send-test-alert
 * Envia notificação de teste com alertas de domínios (por userId)
 */
router.post('/send-test-alert', async (req, res, next) => {
  try {
    const { userId } = req.body;

    console.log('📱 [WHATSAPP] Enviando alerta de teste para usuário:', userId);

    if (!userId) {
      return res.status(400).json({ success: false, error: 'ID do usuário é obrigatório' });
    }

    const result = await notificationService.sendTestAlert(userId);

    console.log(`✅ [WHATSAPP] Alerta de teste enviado com sucesso`);

    res.json({
      success: true,
      message: 'Notificação de teste enviada com sucesso!',
      ...result
    });
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro ao enviar alerta de teste:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao enviar notificação de teste',
      message: error.message
    });
  }
});

/**
 * POST /api/whatsapp/notify-suspended
 * Envia alerta imediato de domínio suspenso
 */
router.post('/notify-suspended', async (req, res, next) => {
  try {
    const { userId, domainName } = req.body;

    if (!userId || !domainName) {
      return res.status(400).json({ error: 'userId e domainName são obrigatórios' });
    }

    const result = await notificationService.sendSuspendedDomainAlert(userId, domainName);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/whatsapp/notify-expired
 * Envia alerta imediato de domínio expirado
 */
router.post('/notify-expired', async (req, res, next) => {
  try {
    const { userId, domainName } = req.body;

    if (!userId || !domainName) {
      return res.status(400).json({ error: 'userId e domainName são obrigatórios' });
    }

    const result = await notificationService.sendExpiredDomainAlert(userId, domainName);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/whatsapp/send-critical-report
 * Envia relatório de domínios críticos
 */
router.post('/send-critical-report', async (req, res, next) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId é obrigatório' });
    }

    const result = await notificationService.sendCriticalDomainsReport(userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/whatsapp/critical-stats/:userId
 * Retorna estatísticas de domínios críticos
 */
router.get('/critical-stats/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const stats = await notificationService.getCriticalDomainsStats(userId);
    res.json({ success: true, stats });
  } catch (error) {
    next(error);
  }
});

module.exports = router;