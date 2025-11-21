const express = require('express');
const router = express.Router();
const whatsappService = require('../../services/whatsapp/messages');
const notificationService = require('../../services/whatsapp/notifications');

/**
 * POST /api/whatsapp/check-number
 * Verifica se um número está registrado no WhatsApp
 */
router.post('/check-number', async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;

    console.log('📱 [WHATSAPP] Validando número:', phoneNumber);

    if (!phoneNumber) {
      console.log('❌ [WHATSAPP] Número não fornecido');
      return res.status(400).json({
        error: 'Número de telefone é obrigatório'
      });
    }

    const exists = await whatsappService.checkPhoneNumber(phoneNumber);

    console.log(`${exists ? '✅' : '❌'} [WHATSAPP] Número ${phoneNumber}: ${exists ? 'EXISTE' : 'NÃO EXISTE'}`);

    res.json({
      success: true,
      phoneNumber,
      exists,
      message: exists 
        ? 'Número registrado no WhatsApp' 
        : 'Número não encontrado no WhatsApp'
    });
  } catch (error) {
    console.error('❌ [WHATSAPP] Erro na validação:', error.message);
    next(error);
  }
});

/**
 * POST /api/whatsapp/send-test
 * Envia mensagem de teste
 */
router.post('/send-test', async (req, res, next) => {
  try {
    const { phoneNumber, userName } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        error: 'Número de telefone é obrigatório'
      });
    }

    const message = `🤖 Domain Hub

Olá ${userName || 'Cliente'}!

Esta é uma mensagem de teste para confirmar que suas notificações via WhatsApp estão funcionando corretamente.

✅ Configuração concluída com sucesso!

Você receberá alertas importantes sobre seus domínios neste número.`;

    const result = await whatsappService.sendMessage(phoneNumber, message);

    if (result.success) {
      res.json({
        success: true,
        message: 'Mensagem de teste enviada com sucesso'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Erro ao enviar mensagem de teste'
      });
    }
  } catch (error) {
    next(error);
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
      return res.status(400).json({
        error: 'userId e domainName são obrigatórios'
      });
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
      return res.status(400).json({
        error: 'userId e domainName são obrigatórios'
      });
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
      return res.status(400).json({
        error: 'userId é obrigatório'
      });
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

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/whatsapp/send-test-alert
 * Envia notificação de teste com alertas de domínios
 */
router.post('/send-test-alert', async (req, res, next) => {
  try {
    const { userId } = req.body;

    console.log('📱 [WHATSAPP] Enviando alerta de teste para usuário:', userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'ID do usuário é obrigatório'
      });
    }

    const result = await notificationService.sendTestAlert(userId);

    console.log(`✅ [WHATSAPP] Alerta de teste enviado com sucesso`);

    res.json({
      success: true,
      message: 'Notificação de teste enviada com sucesso!',
      phoneNumber: result.phoneNumber,
      alertsSent: result.alertsSent,
      suspended: result.suspended,
      expired: result.expired
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

module.exports = router;