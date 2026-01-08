/**
 * ROTAS DE DESATIVAÇÃO DE DOMÍNIOS
 * 
 * Endpoints para gerenciar a desativação completa de domínios
 */

const express = require('express');
const router = express.Router();
const DomainDeactivationService = require('../../services/domain-deactivation');

const deactivationService = new DomainDeactivationService();

/**
 * GET /api/domains/deactivation/detect/:domainName
 * Detecta as integrações existentes para um domínio
 */
router.get('/detect/:domainName', async (req, res) => {
  try {
    const { domainName } = req.params;
    
    console.log(`\n📡 [API] Recebida requisição de detecção para: ${domainName}`);
    
    const integrations = await deactivationService.detectIntegrations(domainName);
    
    res.json({
      success: true,
      domainName,
      integrations
    });
    
  } catch (error) {
    console.error(`❌ [API] Erro na detecção:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/domains/deactivation/execute
 * Executa a desativação completa do domínio
 * 
 * Body: { domainId, domainName }
 */
router.post('/execute', async (req, res) => {
  try {
    const { domainId, domainName } = req.body;
    
    if (!domainId || !domainName) {
      return res.status(400).json({
        success: false,
        error: 'domainId e domainName são obrigatórios'
      });
    }
    
    console.log(`\n📡 [API] Recebida requisição de desativação:`);
    console.log(`   Domain ID: ${domainId}`);
    console.log(`   Domain Name: ${domainName}`);
    
    const result = await deactivationService.deactivateDomain(domainId, domainName);
    
    res.json({
      success: result.overallSuccess,
      result
    });
    
  } catch (error) {
    console.error(`❌ [API] Erro na desativação:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/domains/deactivation/step/wordpress
 * Executa apenas a desinstalação do WordPress
 * 
 * Body: { domainName }
 */
router.post('/step/wordpress', async (req, res) => {
  try {
    const { domainName } = req.body;
    
    if (!domainName) {
      return res.status(400).json({
        success: false,
        error: 'domainName é obrigatório'
      });
    }
    
    console.log(`\n📡 [API] Desinstalando WordPress de: ${domainName}`);
    
    // Buscar instalação
    const installation = await deactivationService.findWordPressInstallation(domainName);
    
    if (!installation) {
      return res.json({
        success: true,
        skipped: true,
        message: 'WordPress não encontrado para este domínio'
      });
    }
    
    // Desinstalar
    const result = await deactivationService.uninstallWordPress(installation.insid);
    
    res.json({
      success: result.success,
      message: result.message,
      insid: installation.insid
    });
    
  } catch (error) {
    console.error(`❌ [API] Erro ao desinstalar WordPress:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/domains/deactivation/step/whm
 * Executa apenas a remoção da conta WHM
 * 
 * Body: { domainName }
 */
router.post('/step/whm', async (req, res) => {
  try {
    const { domainName } = req.body;
    
    if (!domainName) {
      return res.status(400).json({
        success: false,
        error: 'domainName é obrigatório'
      });
    }
    
    console.log(`\n📡 [API] Removendo conta WHM para: ${domainName}`);
    
    // Verificar se existe
    const whmAccount = await deactivationService.findWHMAccount(domainName);
    
    if (!whmAccount) {
      return res.json({
        success: true,
        skipped: true,
        message: 'Conta não encontrada no WHM'
      });
    }
    
    // Remover
    const result = await deactivationService.removeWHMAccount(domainName);
    
    res.json({
      success: result.success,
      message: result.message
    });
    
  } catch (error) {
    console.error(`❌ [API] Erro ao remover conta WHM:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/domains/deactivation/step/cloudflare
 * Executa apenas a remoção da zona do Cloudflare
 * 
 * Body: { domainName }
 */
router.post('/step/cloudflare', async (req, res) => {
  try {
    const { domainName } = req.body;
    
    if (!domainName) {
      return res.status(400).json({
        success: false,
        error: 'domainName é obrigatório'
      });
    }
    
    console.log(`\n📡 [API] Removendo zona Cloudflare: ${domainName}`);
    
    // Verificar se existe
    const zone = await deactivationService.findCloudflareZone(domainName);
    
    if (!zone) {
      return res.json({
        success: true,
        skipped: true,
        message: 'Zona não encontrada no Cloudflare'
      });
    }
    
    // Remover
    const result = await deactivationService.removeCloudflareZone(zone.id, domainName);
    
    res.json({
      success: result.success,
      message: result.message,
      zoneId: zone.id
    });
    
  } catch (error) {
    console.error(`❌ [API] Erro ao remover do Cloudflare:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/domains/deactivation/step/supabase
 * Executa apenas a desativação no Supabase
 * 
 * Body: { domainId }
 */
router.post('/step/supabase', async (req, res) => {
  try {
    const { domainId } = req.body;
    
    if (!domainId) {
      return res.status(400).json({
        success: false,
        error: 'domainId é obrigatório'
      });
    }
    
    console.log(`\n📡 [API] Desativando no Supabase: ${domainId}`);
    
    const result = await deactivationService.deactivateInSupabase(domainId);
    
    res.json({
      success: result.success,
      message: result.message
    });
    
  } catch (error) {
    console.error(`❌ [API] Erro ao desativar no Supabase:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;