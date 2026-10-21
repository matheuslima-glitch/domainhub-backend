const express = require('express');
const router = express.Router();
const namecheapNameservers = require('../../services/namecheap/nameservers');
// Cada chamada age sobre UM dominio, entao precisa da credencial da conta
// DELE. Com uma conta so, devolve sempre a principal e nada muda.
const { contaDoDominio } = require('../../services/namecheap/conta-do-dominio');
const { createClient } = require('@supabase/supabase-js');

// Inicializar Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    const result = await namecheapNameservers.setNameservers(
      domainName,
      nameservers,
      await contaDoDominio(domainName),
    );
    
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
 * POST /api/domains/nameservers/set-default
 * Configura DNS predefinido da Namecheap (BasicDNS)
 */
router.post('/set-default', async (req, res, next) => {
  try {
    const { domainName, dnsType } = req.body;
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📝 [API] Configurar DNS predefinido`);
    console.log(`   Domínio: ${domainName}`);
    console.log(`   Tipo DNS: ${dnsType}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    // Validações básicas
    if (!domainName) {
      return res.status(400).json({
        success: false,
        error: 'Nome do domínio é obrigatório'
      });
    }
    
    if (!dnsType || dnsType !== 'BasicDNS') {
      return res.status(400).json({
        success: false,
        error: 'Tipo de DNS inválido. Use "BasicDNS"'
      });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // ETAPA 1: Configurar DNS predefinido na Namecheap
    // ═══════════════════════════════════════════════════════════════
    
    const result = await namecheapNameservers.setDefaultDNS(
      domainName,
      dnsType,
      await contaDoDominio(domainName),
    );
    
    console.log(`\n✅ [API] ${dnsType} configurado com sucesso na Namecheap`);
    console.log(`   Domínio: ${result.domain}`);
    console.log(`   Status: ${result.updated ? 'Atualizado' : 'Processado'}`);
    
    // ═══════════════════════════════════════════════════════════════
    // ETAPA 2: Buscar os novos nameservers da Namecheap
    // ═══════════════════════════════════════════════════════════════
    
    console.log(`\n🔍 [API] Buscando nameservers atualizados da Namecheap...`);
    
    const nameserversData = await namecheapNameservers.getNameservers(
      domainName,
      await contaDoDominio(domainName),
    );
    const newNameservers = nameserversData.nameservers || [];
    
    console.log(`   Nameservers obtidos: ${newNameservers.length}`);
    console.log(`   Lista:`, newNameservers);
    
    // ═══════════════════════════════════════════════════════════════
    // ETAPA 3: Atualizar nameservers no Supabase
    // ═══════════════════════════════════════════════════════════════
    
    console.log(`\n💾 [API] Salvando nameservers no banco de dados...`);
    
    const { error: updateError } = await supabase
      .from('domains')
      .update({ nameservers: newNameservers })
      .eq('domain_name', domainName);
    
    if (updateError) {
      console.error(`❌ [API] Erro ao salvar no banco:`, updateError);
      // Não falha a requisição, apenas loga o erro
      console.warn(`⚠️ [API] DNS configurado na Namecheap mas não salvo no banco`);
    } else {
      console.log(`✅ [API] Nameservers salvos no banco de dados`);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RETORNAR SUCESSO
    // ═══════════════════════════════════════════════════════════════
    
    res.json({
      success: true,
      data: {
        ...result,
        nameservers: newNameservers
      }
    });
    
  } catch (error) {
    console.error(`\n❌ [API] Erro ao configurar DNS predefinido:`);
    console.error(`   Mensagem: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao configurar DNS predefinido na Namecheap'
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
    const result = await namecheapNameservers.getNameservers(
      domainName,
      await contaDoDominio(domainName),
    );
    
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