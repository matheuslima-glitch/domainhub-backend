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
    let rateLimitHits = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;

    for (const domain of domains) {
      processedCount++;
      console.log(`📋 Processando ${processedCount}/${domains.length}: ${domain.domain_name}`);
      
      let details = await namecheapService.getDomainInfo(domain.domain_name);
      
      if (!details.has_error) {
        detailedDomains.push(details);
        rateLimitHits = 0;
      } else if (details.error_type === 'rate_limit') {
        rateLimitHits++;
        console.warn(`⚠️ Rate limit atingido (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES}) em ${domain.domain_name}`);
        
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          console.error(`❌ Rate limit persistente. Parando sincronização. Progresso: ${processedCount}/${domains.length}`);
          break;
        }
        
        console.log('⏳ Aguardando 2 minutos antes de continuar...');
        await namecheapService.delay(120000);
        
        details = await namecheapService.getDomainInfo(domain.domain_name);
        if (!details.has_error) {
          detailedDomains.push(details);
          rateLimitHits = 0;
        }
      } else if (details.error_type === 'other_error') {
        console.warn(`⚠️ Erro em ${domain.domain_name}: ${details.error_message}`);
        
        if (details.has_alert) {
          detailedDomains.push(details);
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
        processed: processedCount,
        saved: results.success,
        failed: results.failed,
        errors: results.errors,
        stopped_early: processedCount < domains.length
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;