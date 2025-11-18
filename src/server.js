// Servidor Express principal

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cron = require('node-cron');
const config = require('./config/env');
const errorHandler = require('./middlewares/error');
const balanceRoutes = require('./routes/balance');

const app = express();

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    service: 'DomainHub Backend',
    version: '1.0.0',
    status: 'online'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime()
  });
});

app.get('/api/ip', async (req, res) => {
  const axios = require('axios');
  try {
    const { data } = await axios.get('https://api.ipify.org?format=json');
    res.json({
      ip: data.ip,
      message: 'Adicione este IP na whitelist da Namecheap'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao obter IP' });
  }
});

app.use('/api/balance', balanceRoutes);
app.use('/api/domains', require('./routes/domains'));

app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada'
  });
});

app.use(errorHandler);

cron.schedule('0 */4 * * *', async () => {
  console.log('🔄 [CRON] Iniciando sincronização automática de domínios...');
  
  try {
    const namecheapDomains = require('./services/namecheap/domains');
    const supabaseDomains = require('./services/supabase/domains');
    
    // Listar todos os domínios
    const domains = await namecheapDomains.syncAllDomains();
    console.log(`✅ [CRON] ${domains.length} domínios listados da Namecheap`);
    
    // Configurações
    const BATCH_SIZE = 100; // Salvar a cada 100 domínios processados
    const rateLimitDelay = 250;
    const MAX_RATE_LIMIT_RETRIES = 3;
    
    // Contadores
    let processedCount = 0;
    let rateLimitHits = 0;
    let totalSaved = 0;
    let totalFailed = 0;
    const allErrors = [];
    
    // Batch atual
    let currentBatch = [];

    console.log(`\n📦 [CRON] Processamento em lotes de ${BATCH_SIZE} domínios`);
    console.log(`⏱️ [CRON] Delay entre requisições: ${rateLimitDelay}ms\n`);

    for (const domain of domains) {
      processedCount++;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📋 [CRON] [${processedCount}/${domains.length}] Processando: ${domain.domain_name}`);
      
      // Buscar informações detalhadas do domínio
      let details = await namecheapDomains.getDomainInfo(domain.domain_name);
      
      // ============================================
      // FLUXO 1: DOMÍNIO SEM ERROS (ACTIVE/EXPIRED)
      // ============================================
      if (!details.has_error) {
        console.log(`✅ [CRON] Domínio processado com sucesso: ${domain.domain_name}`);
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
        console.warn(`\n⚠️ [CRON] RATE LIMIT ATINGIDO (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES})`);
        console.warn(`   Domínio: ${domain.domain_name}`);
        
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          console.error(`\n❌ [CRON] RATE LIMIT PERSISTENTE - PARANDO SINCRONIZAÇÃO`);
          console.error(`   Progresso: ${processedCount}/${domains.length}`);
          console.error(`   Salvando lote atual antes de parar...`);
          
          // Salvar lote atual antes de parar
          if (currentBatch.length > 0) {
            const batchResults = await supabaseDomains.batchUpsertDomains(currentBatch);
            totalSaved += batchResults.success;
            totalFailed += batchResults.failed;
            allErrors.push(...batchResults.errors);
            console.log(`💾 [CRON] Lote final salvo: ${batchResults.success} sucessos, ${batchResults.failed} falhas`);
          }
          
          break;
        }
        
        console.log(`⏳ [CRON] Aguardando 2 minutos (120 segundos)...`);
        await namecheapDomains.delay(120000);
        
        // Tentar novamente após o wait
        console.log(`🔄 [CRON] Tentando novamente: ${domain.domain_name}`);
        details = await namecheapDomains.getDomainInfo(domain.domain_name);
        
        if (!details.has_error) {
          console.log(`✅ [CRON] Sucesso após retry: ${domain.domain_name}`);
          currentBatch.push(details);
          rateLimitHits = 0;
        } else {
          console.warn(`⚠️ [CRON] Ainda com erro após retry: ${domain.domain_name}`);
        }
      } 
      // ============================================
      // FLUXO 3: DOMÍNIO SUSPENSO/BLOQUEADO
      // ============================================
      else if (details.error_type === 'domain_suspended') {
        console.warn(`🔒 [CRON] DOMÍNIO SUSPENSO/BLOQUEADO: ${domain.domain_name}`);
        console.warn(`   Status: ${details.status}`);
        console.warn(`   Tipo de erro: ${details.error_type}`);
        console.warn(`   Mensagem original: ${details.error_message}`);
        
        if (details.has_alert) {
          console.log(`   Alerta traduzido: ${details.has_alert.substring(0, 100)}...`);
          console.log(`   ✅ [CRON] Adicionando ao lote para salvar apenas status e has_alert`);
          currentBatch.push(details);
        } else {
          console.warn(`   ⚠️ [CRON] Sem alerta traduzido, pulando...`);
        }
      }
      // ============================================
      // FLUXO 4: OUTROS ERROS
      // ============================================
      else {
        console.warn(`⚠️ [CRON] OUTRO ERRO em ${domain.domain_name}`);
        console.warn(`   Tipo: ${details.error_type}`);
        console.warn(`   Mensagem: ${details.error_message}`);
        
        if (details.has_alert) {
          console.log(`   ✅ [CRON] Tem alerta, adicionando ao lote`);
          currentBatch.push(details);
        } else {
          console.log(`   ⚠️ [CRON] Sem alerta, pulando...`);
        }
      }
      
      // ============================================
      // SALVAMENTO A CADA 100 DOMÍNIOS PROCESSADOS
      // ============================================
      if (currentBatch.length >= BATCH_SIZE) {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`💾 [CRON] SALVANDO LOTE NO SUPABASE`);
        console.log(`   Tamanho do lote: ${currentBatch.length} domínios`);
        console.log(`   Progresso geral: ${processedCount}/${domains.length}`);
        
        const batchResults = await supabaseDomains.batchUpsertDomains(currentBatch);
        
        totalSaved += batchResults.success;
        totalFailed += batchResults.failed;
        allErrors.push(...batchResults.errors);
        
        console.log(`✅ [CRON] Lote salvo com sucesso!`);
        console.log(`   Sucessos: ${batchResults.success}`);
        console.log(`   Falhas: ${batchResults.failed}`);
        console.log(`   Total salvo até agora: ${totalSaved}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        
        // Limpar o lote
        currentBatch = [];
      }
      
      // Delay entre requisições (exceto na última)
      if (processedCount < domains.length) {
        await namecheapDomains.delay(rateLimitDelay);
      }
    }

    // ============================================
    // SALVAR LOTE FINAL (SE HOUVER DOMÍNIOS RESTANTES)
    // ============================================
    if (currentBatch.length > 0) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`💾 [CRON] SALVANDO LOTE FINAL NO SUPABASE`);
      console.log(`   Tamanho do lote: ${currentBatch.length} domínios`);
      
      const batchResults = await supabaseDomains.batchUpsertDomains(currentBatch);
      
      totalSaved += batchResults.success;
      totalFailed += batchResults.failed;
      allErrors.push(...batchResults.errors);
      
      console.log(`✅ [CRON] Lote final salvo!`);
      console.log(`   Sucessos: ${batchResults.success}`);
      console.log(`   Falhas: ${batchResults.failed}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }

    // ============================================
    // RESUMO FINAL
    // ============================================
    console.log(`\n╔════════════════════════════════════════════════╗`);
    console.log(`║    [CRON] SINCRONIZAÇÃO FINALIZADA            ║`);
    console.log(`╠════════════════════════════════════════════════╣`);
    console.log(`║ Total de domínios listados: ${domains.length.toString().padEnd(17)}║`);
    console.log(`║ Domínios processados: ${processedCount.toString().padEnd(22)}║`);
    console.log(`║ Salvos com sucesso: ${totalSaved.toString().padEnd(24)}║`);
    console.log(`║ Falhas ao salvar: ${totalFailed.toString().padEnd(26)}║`);
    console.log(`║ Parou antes do fim: ${(processedCount < domains.length ? 'Sim' : 'Não').padEnd(24)}║`);
    console.log(`╚════════════════════════════════════════════════╝\n`);
    
  } catch (error) {
    console.error(`\n❌ [CRON] ERRO CRÍTICO NA SINCRONIZAÇÃO:`);
    console.error(error);
  }
});

app.listen(config.PORT, async () => {
  console.log(`Servidor rodando na porta ${config.PORT}`);
  console.log(`Ambiente: ${config.NODE_ENV}`);
  console.log('🕐 Cron de domínios configurado: A cada 4 horas');
  console.log('📦 Processamento em lotes de 100 domínios');
  
  const namecheapBalance = require('./services/namecheap/balance');
  const ip = await namecheapBalance.getServerIP();
  console.log(`IP do servidor: ${ip}`);
  console.log('Adicione na whitelist: https://ap.www.namecheap.com/settings/tools/apiaccess/');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));