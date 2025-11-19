const express = require('express');
const router = express.Router();
const namecheapService = require('../../services/namecheap/domains');
const supabaseService = require('../../services/supabase/domains');

// Importar rotas de nameservers
router.use('/nameservers', require('./nameservers'));

router.post('/sync', async (req, res, next) => {
  try {
    console.log('🚀 Iniciando sincronização de domínios...');
    
    // Listar todos os domínios
    const domains = await namecheapService.syncAllDomains();
    console.log(`✅ ${domains.length} domínios listados da Namecheap`);
    
    // Configurações
    const BATCH_SIZE = 100; // Salvar a cada 100 domínios processados
    const rateLimitDelay = 250; // Delay entre requisições
    const MAX_RATE_LIMIT_RETRIES = 3;
    
    // Contadores
    let processedCount = 0;
    let rateLimitHits = 0;
    let totalSaved = 0;
    let totalFailed = 0;
    const allErrors = [];
    
    // Batch atual
    let currentBatch = [];

    console.log(`\n📦 Processamento em lotes de ${BATCH_SIZE} domínios`);
    console.log(`⏱️ Delay entre requisições: ${rateLimitDelay}ms\n`);

    for (const domain of domains) {
      processedCount++;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📋 [${processedCount}/${domains.length}] Processando: ${domain.domain_name}`);
      
      // Buscar informações detalhadas do domínio
      let details = await namecheapService.getDomainInfo(domain.domain_name);
      
      // ============================================
      // FLUXO 1: DOMÍNIO SEM ERROS (ACTIVE/EXPIRED)
      // ============================================
      if (!details.has_error) {
        console.log(`✅ Domínio processado com sucesso: ${domain.domain_name}`);
        console.log(`   Status: ${details.status}`);
        console.log(`   Expiração: ${details.expiration_date}`);
        
        currentBatch.push(details);
        rateLimitHits = 0;
      } 
      // ============================================
      // FLUXO 2: RATE LIMIT
      // ============================================
      else if (details.error_type === 'rate_limit') {
        rateLimitHits++;
        console.warn(`\n⚠️ RATE LIMIT ATINGIDO (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES})`);
        console.warn(`   Domínio: ${domain.domain_name}`);
        
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          console.error(`\n❌ RATE LIMIT PERSISTENTE - PARANDO SINCRONIZAÇÃO`);
          console.error(`   Progresso: ${processedCount}/${domains.length}`);
          console.error(`   Salvando lote atual antes de parar...`);
          
          // Salvar lote atual antes de parar
          if (currentBatch.length > 0) {
            const batchResults = await supabaseService.batchUpsertDomains(currentBatch);
            totalSaved += batchResults.success;
            totalFailed += batchResults.failed;
            allErrors.push(...batchResults.errors);
            console.log(`💾 Lote final salvo: ${batchResults.success} sucessos, ${batchResults.failed} falhas`);
          }
          
          break;
        }
        
        console.log(`⏳ Aguardando 2 minutos (120 segundos)...`);
        await namecheapService.delay(120000);
        
        // Tentar novamente após o wait
        console.log(`🔄 Tentando novamente: ${domain.domain_name}`);
        details = await namecheapService.getDomainInfo(domain.domain_name);
        
        if (!details.has_error) {
          console.log(`✅ Sucesso após retry: ${domain.domain_name}`);
          currentBatch.push(details);
          rateLimitHits = 0;
        } else {
          console.warn(`⚠️ Ainda com erro após retry: ${domain.domain_name}`);
        }
      } 
      // ============================================
      // FLUXO 3: DOMÍNIO SUSPENSO/BLOQUEADO
      // ============================================
      else if (details.error_type === 'domain_suspended') {
        console.warn(`🔒 DOMÍNIO SUSPENSO/BLOQUEADO: ${domain.domain_name}`);
        console.warn(`   Status: ${details.status}`);
        console.warn(`   Tipo de erro: ${details.error_type}`);
        console.warn(`   Mensagem original: ${details.error_message}`);
        
        if (details.has_alert) {
          console.log(`   Alerta traduzido: ${details.has_alert.substring(0, 100)}...`);
          console.log(`   ✅ Adicionando ao lote para salvar apenas status e has_alert`);
          currentBatch.push(details);
        } else {
          console.warn(`   ⚠️ Sem alerta traduzido, pulando...`);
        }
      }
      // ============================================
      // FLUXO 4: OUTROS ERROS
      // ============================================
      else {
        console.warn(`⚠️ OUTRO ERRO em ${domain.domain_name}`);
        console.warn(`   Tipo: ${details.error_type}`);
        console.warn(`   Mensagem: ${details.error_message}`);
        
        if (details.has_alert) {
          console.log(`   ✅ Tem alerta, adicionando ao lote`);
          currentBatch.push(details);
        } else {
          console.log(`   ⚠️ Sem alerta, pulando...`);
        }
      }
      
      // ============================================
      // SALVAMENTO A CADA 100 DOMÍNIOS PROCESSADOS
      // ============================================
      if (currentBatch.length >= BATCH_SIZE) {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`💾 SALVANDO LOTE NO SUPABASE`);
        console.log(`   Tamanho do lote: ${currentBatch.length} domínios`);
        console.log(`   Progresso geral: ${processedCount}/${domains.length}`);
        
        const batchResults = await supabaseService.batchUpsertDomains(currentBatch);
        
        totalSaved += batchResults.success;
        totalFailed += batchResults.failed;
        allErrors.push(...batchResults.errors);
        
        console.log(`✅ Lote salvo com sucesso!`);
        console.log(`   Sucessos: ${batchResults.success}`);
        console.log(`   Falhas: ${batchResults.failed}`);
        console.log(`   Total salvo até agora: ${totalSaved}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        
        // Limpar o lote
        currentBatch = [];
      }
      
      // Delay entre requisições (exceto na última)
      if (processedCount < domains.length) {
        await namecheapService.delay(rateLimitDelay);
      }
    }

    // ============================================
    // SALVAR LOTE FINAL (SE HOUVER DOMÍNIOS RESTANTES)
    // ============================================
    if (currentBatch.length > 0) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`💾 SALVANDO LOTE FINAL NO SUPABASE`);
      console.log(`   Tamanho do lote: ${currentBatch.length} domínios`);
      
      const batchResults = await supabaseService.batchUpsertDomains(currentBatch);
      
      totalSaved += batchResults.success;
      totalFailed += batchResults.failed;
      allErrors.push(...batchResults.errors);
      
      console.log(`✅ Lote final salvo!`);
      console.log(`   Sucessos: ${batchResults.success}`);
      console.log(`   Falhas: ${batchResults.failed}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }

    // ============================================
    // RESUMO FINAL
    // ============================================
    console.log(`\n╔════════════════════════════════════════════════╗`);
    console.log(`║         SINCRONIZAÇÃO FINALIZADA              ║`);
    console.log(`╠════════════════════════════════════════════════╣`);
    console.log(`║ Total de domínios listados: ${domains.length.toString().padEnd(17)}║`);
    console.log(`║ Domínios processados: ${processedCount.toString().padEnd(22)}║`);
    console.log(`║ Salvos com sucesso: ${totalSaved.toString().padEnd(24)}║`);
    console.log(`║ Falhas ao salvar: ${totalFailed.toString().padEnd(26)}║`);
    console.log(`║ Parou antes do fim: ${(processedCount < domains.length ? 'Sim' : 'Não').padEnd(24)}║`);
    console.log(`╚════════════════════════════════════════════════╝\n`);
    
    // Resposta da API
    res.json({
      success: true,
      data: {
        total_domains: domains.length,
        processed: processedCount,
        saved: totalSaved,
        failed: totalFailed,
        errors: allErrors,
        stopped_early: processedCount < domains.length,
        batch_size: BATCH_SIZE
      }
    });
  } catch (error) {
    console.error(`\n❌ ERRO CRÍTICO NA SINCRONIZAÇÃO:`);
    console.error(error);
    next(error);
  }
});

module.exports = router;