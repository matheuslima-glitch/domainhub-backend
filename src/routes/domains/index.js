const express = require('express');
const router = express.Router();
const namecheapService = require('../../services/namecheap/domains');
const supabaseService = require('../../services/supabase/domains');

router.post('/sync', async (req, res, next) => {
  try {
    console.log('🚀 Iniciando sincronização de domínios...');
    
    const domains = await namecheapService.syncAllDomains();
    console.log(`✅ ${domains.length} domínios listados`);
    
    const detailedDomains = [];
    const rateLimitDelay = 250;
    let processedCount = 0;

    for (const domain of domains) {
      processedCount++;
      console.log(`📋 Processando ${processedCount}/${domains.length}: ${domain.domain_name}`);
      
      const details = await namecheapService.getDomainInfo(domain.domain_name);
      
      if (!details.has_error) {
        detailedDomains.push(details);
      } else if (details.error_type === 'rate_limit') {
        console.warn(`⚠️ Rate limit atingido em ${domain.domain_name}, aguardando 60s...`);
        await namecheapService.delay(60000);
        
        const retry = await namecheapService.getDomainInfo(domain.domain_name);
        if (!retry.has_error) {
          detailedDomains.push(retry);
        }
      }
      
      await namecheapService.delay(rateLimitDelay);
    }

    console.log(`💾 Salvando ${detailedDomains.length} domínios no Supabase...`);
    const results = await supabaseService.batchUpsertDomains(detailedDomains);
    
    res.json({
      success: true,
      data: {
        total_domains: domains.length,
        processed: detailedDomains.length,
        saved: results.success,
        failed: results.failed,
        errors: results.errors
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;