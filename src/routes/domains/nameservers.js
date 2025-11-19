const express = require('express');
const router = express.Router();
const namecheapNameservers = require('../../services/namecheap/nameservers');

/**
 * POST /api/domains/nameservers/update
 * Atualiza os nameservers de um domínio na Namecheap
 */
router.post('/update', async (req, res, next) => {
  try {
    const { domainName, nameservers } = req.body;
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📝 [API] Nova requisição de atualização de nameservers`);
    console.log(`   Domínio: ${domainName}`);
    console.log(`   Nameservers: ${nameservers?.length || 0}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    // Validações básicas
    if (!domainName) {
      return res.status(400).json({
        success: false,
        error: 'Nome do domínio é obrigatório'
      });
    }
    
    if (!nameservers || !Array.isArray(nameservers)) {
      return res.status(400).json({
        success: false,
        error: 'Nameservers devem ser um array'
      });
    }
    
    if (nameservers.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'São necessários no mínimo 2 nameservers'
      });
    }
    
    if (nameservers.length > 12) {
      return res.status(400).json({
        success: false,
        error: 'Máximo de 12 nameservers permitidos'
      });
    }
    
    // Atualizar nameservers na Namecheap
    const result = await namecheapNameservers.setNameservers(domainName, nameservers);
    
    console.log(`\n✅ [API] Nameservers atualizados com sucesso`);
    console.log(`   Domínio: ${result.domain}`);
    console.log(`   Status: ${result.updated ? 'Atualizado' : 'Processado'}`);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error(`\n❌ [API] Erro ao atualizar nameservers:`);
    console.error(`   Mensagem: ${error.message}`);
    
    // Retornar erro apropriado
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao atualizar nameservers na Namecheap'
    });
  }
});

/**
 * GET /api/domains/nameservers/:domainName
 * Consulta os nameservers atuais de um domínio na Namecheap
 */
router.get('/:domainName', async (req, res, next) => {
  try {
    const { domainName } = req.params;
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 [API] Consultando nameservers de ${domainName}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    if (!domainName) {
      return res.status(400).json({
        success: false,
        error: 'Nome do domínio é obrigatório'
      });
    }
    
    // Consultar nameservers na Namecheap
    const result = await namecheapNameservers.getNameservers(domainName);
    
    console.log(`\n✅ [API] Nameservers consultados com sucesso`);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error(`\n❌ [API] Erro ao consultar nameservers:`);
    console.error(`   Mensagem: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao consultar nameservers na Namecheap'
    });
  }
});

module.exports = router;